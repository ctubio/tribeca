import Models = require("../share/models");
import Publish = require("./publish");
import Utils = require("./utils");
import _ = require("lodash");
import Quoter = require("./quoter");
import Interfaces = require("./interfaces");
import Persister = require("./persister");
import QuotingParameters = require("./quoting-parameters");
import FairValue = require("./fair-value");
import moment = require("moment");
import log from "./logging";
import * as Promises from './promises';

export class MarketDataBroker implements Interfaces.IMarketDataBroker {
    MarketData = new Utils.Evt<Models.Market>();
    public get currentBook(): Models.Market { return this._currentBook; }

    private _currentBook: Models.Market = null;
    private handleMarketData = (book: Models.Market) => {
        this._currentBook = book;
        this.MarketData.trigger(this.currentBook);
        this._marketPublisher.publish(this.currentBook);
    };

    constructor(
      private _mdGateway: Interfaces.IMarketDataGateway,
      private _marketPublisher: Publish.IPublish<Models.Market>
    ) {
      _marketPublisher.registerSnapshot(() => this.currentBook === null ? []: [this.currentBook]);

      this._mdGateway.MarketData.on(this.handleMarketData);
      this._mdGateway.ConnectChanged.on(s => {
        if (s == Models.ConnectivityStatus.Disconnected) this._currentBook = null;
      });
    }
}

export class OrderStateCache implements Interfaces.IOrderStateCache {
    public allOrders = new Map<string, Models.OrderStatusReport>();
    public exchIdsToClientIds = new Map<string, string>();
}

export class OrderBroker implements Interfaces.IOrderBroker {
    private _log = log("oe:broker");

    async cancelOpenOrders() : Promise<number> {
        if (this._oeGateway.supportsCancelAllOpenOrders()) {
            return this._oeGateway.cancelAllOpenOrders();
        }

        const promiseMap = new Map<string, Promises.Deferred<void>>();

        const orderUpdate = (o : Models.OrderStatusReport) => {
            const p = promiseMap.get(o.orderId);
            if (p && (o.orderStatus == Models.OrderStatus.Complete || o.orderStatus == Models.OrderStatus.Cancelled || o.orderStatus == Models.OrderStatus.Rejected))
                p.resolve(null);
        };

        this.OrderUpdate.on(orderUpdate);

        for (let e of this._orderCache.allOrders.values()) {
            if (e.pendingCancel || e.orderStatus == Models.OrderStatus.Complete || e.orderStatus == Models.OrderStatus.Cancelled || e.orderStatus == Models.OrderStatus.Rejected)
                continue;

            this.cancelOrder(new Models.OrderCancel(e.orderId, e.exchange, this._timeProvider.utcNow()));
            promiseMap.set(e.orderId, Promises.defer<void>());
        }

        const promises = Array.from(promiseMap.values());
        await Promise.all(promises);

        this.OrderUpdate.off(orderUpdate);

        return promises.length;
    }

    cleanClosedOrders() : Promise<number> {
        var deferred = Promises.defer<number>();

        var lateCleans : {[id: string] : boolean} = {};
        for(var i = 0;i<this._trades.length;i++) {
          if (this._trades[i].Kqty+0.0001 >= this._trades[i].quantity) {
            lateCleans[this._trades[i].tradeId] = true;
          }
        }

        if (_.isEmpty(_.keys(lateCleans))) {
            deferred.resolve(0);
        }

        for (var k in lateCleans) {
          if (!(k in lateCleans)) continue;
          for(var i = 0;i<this._trades.length;i++) {
            if (k == this._trades[i].tradeId) {
              this._trades[i].Kqty = -1;
              this._tradePublisher.publish(this._trades[i]);
              this._tradePersister.repersist(this._trades[i], this._trades[i]);
              this._trades.splice(i, 1);
              break;
            }
          }
        }

        if (_.every(_.values(lateCleans)))
            deferred.resolve(_.size(lateCleans));

        return deferred.promise;
    }

    cleanOrders() : Promise<number> {
        var deferred = Promises.defer<number>();

        var lateCleans : {[id: string] : boolean} = {};
        for(var i = 0;i<this._trades.length;i++) {
          lateCleans[this._trades[i].tradeId] = true;
        }

        if (_.isEmpty(_.keys(lateCleans))) {
            deferred.resolve(0);
        }

        for (var k in lateCleans) {
          if (!(k in lateCleans)) continue;
          for(var i = 0;i<this._trades.length;i++) {
            if (k == this._trades[i].tradeId) {
              this._trades[i].Kqty = -1;
              this._tradePublisher.publish(this._trades[i]);
              this._tradePersister.repersist(this._trades[i], this._trades[i]);
              this._trades.splice(i, 1);
              break;
            }
          }
        }

        if (_.every(_.values(lateCleans)))
            deferred.resolve(_.size(lateCleans));

        return deferred.promise;
    }

    private roundPrice = (price: number, side: Models.Side) : number => {
        return Utils.roundSide(price, this._baseBroker.minTickIncrement, side);
    }

    OrderUpdate = new Utils.Evt<Models.OrderStatusReport>();
    private _cancelsWaitingForExchangeOrderId: {[clId : string]: Models.OrderCancel} = {};

    Trade = new Utils.Evt<Models.Trade>();
    _trades : Models.Trade[] = [];

    sendOrder = (order : Models.SubmitNewOrder) : Models.SentOrder => {
        const orderId = this._oeGateway.generateClientOrderId();

        const rpt : Models.OrderStatusUpdate = {
            pair: this._baseBroker.pair,
            orderId: orderId,
            side: order.side,
            quantity: order.quantity,
            leavesQuantity: order.quantity,
            type: order.type,
            price: this.roundPrice(order.price, order.side),
            timeInForce: order.timeInForce,
            orderStatus: Models.OrderStatus.New,
            preferPostOnly: order.preferPostOnly,
            exchange: this._baseBroker.exchange(),
            rejectMessage: order.msg,
            source: order.source
        };

        this._oeGateway.sendOrder(this.updateOrderState(rpt));

        return new Models.SentOrder(rpt.orderId);
    };

    replaceOrder = (replace : Models.CancelReplaceOrder) : Models.SentOrder => {
        const rpt = this._orderCache.allOrders.get(replace.origOrderId);
        if (!rpt) throw new Error("Unknown order, cannot replace " + replace.origOrderId);

        const report : Models.OrderStatusUpdate = {
            orderId: replace.origOrderId,
            orderStatus: Models.OrderStatus.Working,
            pendingReplace: true,
            price: this.roundPrice(replace.price, rpt.side),
            quantity: replace.quantity
        };

        this._oeGateway.replaceOrder(this.updateOrderState(rpt));

        return new Models.SentOrder(report.orderId);
    };

    cancelOrder = (cancel: Models.OrderCancel) => {
        const rpt = this._orderCache.allOrders.get(cancel.origOrderId);
        if (!rpt) {
          this._oeGateway.cancelOrder(this.updateOrderState(<Models.OrderStatusUpdate>{
              orderId: cancel.origOrderId,
              orderStatus: Models.OrderStatus.Cancelled,
              leavesQuantity: 0
              ,done: true
          }));
          return;
        }

        if (!this._oeGateway.cancelsByClientOrderId) {
            // race condition! i cannot cancel an order before I get the exchangeId (oid); register it for deletion on the ack
            if (typeof rpt.exchangeId === "undefined") {
                this._cancelsWaitingForExchangeOrderId[rpt.orderId] = cancel;
                // this._log.info("Registered %s for late deletion", rpt.orderId);
                return;
            }
        }

        if (!rpt) throw new Error("Unknown order, cannot cancel " + cancel.origOrderId);

        const report: Models.OrderStatusUpdate = {
            orderId: cancel.origOrderId,
            orderStatus: Models.OrderStatus.Working,
            pendingCancel: true
        };

        this._oeGateway.cancelOrder(this.updateOrderState(report));
    };

    private _reTrade = (reTrades: Models.Trade[], trade: Models.Trade): string => {
      let tradePingPongType = 'Ping';
      let gowhile = true;
      while (gowhile && trade.quantity>0 && reTrades!=null && reTrades.length) {
        var reTrade = reTrades.shift();
        gowhile = false;
        for(var i = 0;i<this._trades.length;i++) {
          if (this._trades[i].tradeId==reTrade.tradeId) {
            gowhile = true;
            var Kqty = Math.min(trade.quantity, this._trades[i].quantity - this._trades[i].Kqty);
            this._trades[i].Ktime = trade.time;
            this._trades[i].Kprice = ((Kqty*trade.price) + (this._trades[i].Kqty*this._trades[i].Kprice)) / (this._trades[i].Kqty+Kqty);
            this._trades[i].Kqty += Kqty;
            this._trades[i].Kvalue = Math.abs(this._trades[i].Kprice*this._trades[i].Kqty);
            trade.quantity -= Kqty;
            trade.value = Math.abs(trade.price*trade.quantity);
            if (this._trades[i].quantity<=this._trades[i].Kqty)
              this._trades[i].Kdiff = Math.abs((this._trades[i].quantity*this._trades[i].price)-(this._trades[i].Kqty*this._trades[i].Kprice));
            this._trades[i].loadedFromDB = false;
            tradePingPongType = 'Pong';
            this._tradePublisher.publish(this._trades[i]);
            this._tradePersister.repersist(this._trades[i], this._trades[i]);
            break;
          }
        }
      }
      if (trade.quantity>0) {
        var exists = false;
        for(var i = 0;i<this._trades.length;i++) {
          if (this._trades[i].price==trade.price && this._trades[i].side==trade.side && this._trades[i].quantity>this._trades[i].Kqty) {
            exists = true;
            this._trades[i].time = trade.time;
            this._trades[i].quantity += trade.quantity;
            this._trades[i].value += trade.value;
            this._trades[i].loadedFromDB = false;
            this._tradePublisher.publish(this._trades[i]);
            this._tradePersister.repersist(this._trades[i], this._trades[i]);
            break;
          }
        }
        if (!exists) {
          this._tradePublisher.publish(trade);
          this._tradePersister.persist(trade);
          this._trades.push(trade);
        }
      }
      return tradePingPongType;
    };

    public updateOrderState = (osr : Models.OrderStatusUpdate) : Models.OrderStatusReport => {
        let orig : Models.OrderStatusUpdate;
        if (osr.orderStatus === Models.OrderStatus.New) {
            orig = osr;
        } else {
            orig = this._orderCache.allOrders.get(osr.orderId);

            if (typeof orig === "undefined") {
                const secondChance = this._orderCache.exchIdsToClientIds.get(osr.exchangeId);
                if (typeof secondChance !== "undefined") {
                    osr.orderId = secondChance;
                    orig = this._orderCache.allOrders.get(secondChance);
                }
            }

            if (typeof orig === "undefined") return;
        }

        const getOrFallback = <T>(n: T, o: T) => typeof n !== "undefined" ? n : o;

        const quantity = getOrFallback(osr.quantity, orig.quantity);

        let cumQuantity : number = undefined;
        if (typeof osr.cumQuantity !== "undefined") {
            cumQuantity = getOrFallback(osr.cumQuantity, orig.cumQuantity);
        }
        else {
            cumQuantity = getOrFallback(orig.cumQuantity, 0) + getOrFallback(osr.lastQuantity, 0);
        }

        const partiallyFilled = cumQuantity > 0 && cumQuantity !== quantity;

        const o : Models.OrderStatusReport = {
          pair: getOrFallback(osr.pair, orig.pair),
          side: getOrFallback(osr.side, orig.side),
          quantity: quantity,
          type: getOrFallback(osr.type, orig.type),
          price: getOrFallback(osr.price, orig.price),
          timeInForce: getOrFallback(osr.timeInForce, orig.timeInForce),
          orderId: getOrFallback(osr.orderId, orig.orderId),
          exchangeId: getOrFallback(osr.exchangeId, orig.exchangeId),
          orderStatus: getOrFallback(osr.orderStatus, orig.orderStatus),
          rejectMessage: osr.rejectMessage,
          time: getOrFallback(osr.time, this._timeProvider.utcNow()),
          lastQuantity: osr.lastQuantity,
          lastPrice: osr.lastPrice,
          leavesQuantity: getOrFallback(osr.leavesQuantity, orig.leavesQuantity),
          cumQuantity: cumQuantity,
          averagePrice: cumQuantity > 0 ? osr.averagePrice || orig.averagePrice : undefined,
          liquidity: getOrFallback(osr.liquidity, orig.liquidity),
          exchange: getOrFallback(osr.exchange, orig.exchange),
          computationalLatency: getOrFallback(osr.computationalLatency, 0) + getOrFallback(orig.computationalLatency, 0),
          version: (typeof orig.version === "undefined") ? 0 : orig.version + 1,
          partiallyFilled: partiallyFilled,
          pendingCancel: osr.pendingCancel,
          pendingReplace: osr.pendingReplace,
          cancelRejected: osr.cancelRejected,
          preferPostOnly: getOrFallback(osr.preferPostOnly, orig.preferPostOnly),
          source: getOrFallback(osr.source, orig.source)
          ,done: osr.done
        };

        this.updateOrderStatusInMemory(o);

        // cancel any open orders waiting for oid
        if (!this._oeGateway.cancelsByClientOrderId
                && typeof o.exchangeId !== "undefined"
                && o.orderId in this._cancelsWaitingForExchangeOrderId) {
            // this._log.info("Deleting %s late, oid: %s", o.exchangeId, o.orderId);
            const cancel = this._cancelsWaitingForExchangeOrderId[o.orderId];
            delete this._cancelsWaitingForExchangeOrderId[o.orderId];
            this.cancelOrder(cancel);
        }

        this.OrderUpdate.trigger(o);
        this._orderStatusPublisher.publish(o);

        if (osr.lastQuantity > 0) {
            let value = Math.abs(o.lastPrice * o.lastQuantity);

            const liq = o.liquidity;
            let feeCharged = null;
            if (typeof liq !== "undefined") {
                // negative fee is a rebate, positive fee is a fee
                feeCharged = (liq === Models.Liquidity.Make ? this._baseBroker.makeFee() : this._baseBroker.takeFee());
                const sign = (o.side === Models.Side.Bid ? 1 : -1);
                value = value * (1 + sign * feeCharged);
            }

            const trade = new Models.Trade(o.orderId+"."+o.version, o.time, o.exchange, o.pair,
                o.lastPrice, o.lastQuantity, o.side, value, o.liquidity, null, 0, 0, 0, 0, feeCharged, false);
            this.Trade.trigger(trade);
            let tradePingPongType = 'Ping';
            if (this._qlParamRepo.latest.mode === Models.QuotingMode.Boomerang || this._qlParamRepo.latest.mode === Models.QuotingMode.AK47)
              tradePingPongType = this._reTrade(this._trades.filter((x: Models.Trade) => (
                (trade.side==Models.Side.Bid?(x.price > (trade.price + this._qlParamRepo.latest.widthPong)):(x.price < (trade.price - this._qlParamRepo.latest.widthPong)))
                && (x.side == (trade.side==Models.Side.Bid?Models.Side.Ask:Models.Side.Bid))
                && ((x.quantity - x.Kqty) > 0)
              )).sort((a: Models.Trade, b: Models.Trade) => (
                (this._qlParamRepo.latest.pongAt == Models.PongAt.LongPingFair || this._qlParamRepo.latest.pongAt == Models.PongAt.LongPingAggressive)
                  ? (
                  trade.side==Models.Side.Bid
                    ? (a.price<b.price?1:(a.price>b.price?-1:0))
                    : (a.price>b.price?1:(a.price<b.price?-1:0))
                ) : (
                  trade.side==Models.Side.Bid
                    ? (a.price>b.price?1:(a.price<b.price?-1:0))
                    : (a.price<b.price?1:(a.price>b.price?-1:0))
                )
              )), trade);
            else {
              this._tradePublisher.publish(trade);
              this._tradePersister.persist(trade);
              this._trades.push(trade);
            }

            this._tradeChartPublisher.publish(new Models.TradeChart(o.lastPrice, o.side, o.lastQuantity, Math.round(value * 100) / 100, tradePingPongType, o.time));
        }

        return o;
    };

    private updateOrderStatusInMemory = (osr: Models.OrderStatusReport) => {
        this._orderCache.exchIdsToClientIds.set(osr.exchangeId, osr.orderId);
        this._orderCache.allOrders.set(osr.orderId, osr);

        if (osr.done===true) {
          this._orderCache.exchIdsToClientIds.delete(osr.exchangeId);
          this._orderCache.allOrders.delete(osr.orderId);
          if (osr.orderId in this._cancelsWaitingForExchangeOrderId)
            delete this._cancelsWaitingForExchangeOrderId[osr.orderId];
        }
    };

    constructor(private _timeProvider: Utils.ITimeProvider,
                private _qlParamRepo: QuotingParameters.QuotingParametersRepository,
                private _baseBroker : Interfaces.IBroker,
                private _oeGateway : Interfaces.IOrderEntryGateway,
                private _tradePersister : Persister.IPersist<Models.Trade>,
                private _orderStatusPublisher : Publish.IPublish<Models.OrderStatusReport>,
                private _tradePublisher : Publish.IPublish<Models.Trade>,
                private _tradeChartPublisher : Publish.IPublish<Models.TradeChart>,
                private _submittedOrderReciever : Publish.IReceive<Models.OrderRequestFromUI>,
                private _cancelOrderReciever : Publish.IReceive<Models.OrderStatusReport>,
                private _cancelAllOrdersReciever : Publish.IReceive<object>,
                private _cleanAllClosedOrdersReciever : Publish.IReceive<object>,
                private _cleanAllOrdersReciever : Publish.IReceive<object>,
                private _orderCache : OrderStateCache,
                initTrades : Models.Trade[]) {
        if (_qlParamRepo.latest.mode === Models.QuotingMode.Boomerang || _qlParamRepo.latest.mode === Models.QuotingMode.AK47)
          _oeGateway.cancelAllOpenOrders();
        _timeProvider.setTimeout(() => { if (_qlParamRepo.latest.cancelOrdersAuto) _oeGateway.cancelAllOpenOrders(); }, moment.duration(5, 'minutes'));

        _.each(initTrades, t => this._trades.push(t));
        _orderStatusPublisher.registerSnapshot(() => Array.from(_orderCache.allOrders.values()).filter(o => o.orderStatus === Models.OrderStatus.New || o.orderStatus === Models.OrderStatus.Working));
        _tradePublisher.registerSnapshot(() => this._trades.map(t => Object.assign(t, { loadedFromDB: true})).slice(-1000));

        _submittedOrderReciever.registerReceiver((o : Models.OrderRequestFromUI) => {
            try {
                const order = new Models.SubmitNewOrder(Models.Side[o.side], o.quantity, Models.OrderType[o.orderType],
                    o.price, Models.TimeInForce[o.timeInForce], _baseBroker.exchange(), _timeProvider.utcNow(), false, Models.OrderSource.OrderTicket);
                this.sendOrder(order);
            }
            catch (e) {
                this._log.error(e, "unhandled exception while submitting order", o);
            }
        });

        _cancelOrderReciever.registerReceiver(o => {
            try {
                this.cancelOrder(new Models.OrderCancel(o.orderId, o.exchange, _timeProvider.utcNow()));
            } catch (e) {
                this._log.error(e, "unhandled exception while submitting order", o);
            }
        });

        _cancelAllOrdersReciever.registerReceiver(() => this.cancelOpenOrders());
        _cleanAllClosedOrdersReciever.registerReceiver(() => this.cleanClosedOrders());
        _cleanAllOrdersReciever.registerReceiver(() => this.cleanOrders());

        _oeGateway.OrderUpdate.on(this.updateOrderState);

        // _oeGateway.ConnectChanged.on(s => {
            // this._log.info("Gateway changed: " + Models.ConnectivityStatus[s]);
        // });
    }
}

export class PositionBroker implements Interfaces.IPositionBroker {
    private _log = log("pos:broker");

    public NewReport = new Utils.Evt<Models.PositionReport>();

    private _report : Models.PositionReport = null;
    public get latestReport() : Models.PositionReport {
        return this._report;
    }

    private _currencies : { [currency : number] : Models.CurrencyPosition } = {};
    public getPosition(currency : Models.Currency) : Models.CurrencyPosition {
        return this._currencies[currency] || new Models.CurrencyPosition(0, 0, currency);
    }

    private onPositionUpdate = (rpt : Models.CurrencyPosition) => {
        if (rpt !== null) this._currencies[rpt.currency] = rpt;
        var basePosition = this.getPosition(this._base.pair.base);
        var quotePosition = this.getPosition(this._base.pair.quote);
        var fv = this._fvEngine.latestFairValue;
        if (typeof basePosition === "undefined" || typeof quotePosition === "undefined" || fv === null) return;

        const baseAmount = basePosition.amount;
        const quoteAmount = quotePosition.amount;
        const baseValue = baseAmount + quoteAmount / fv.price + basePosition.heldAmount + quotePosition.heldAmount / fv.price;
        const quoteValue = baseAmount * fv.price + quoteAmount + basePosition.heldAmount * fv.price + quotePosition.heldAmount;
        const positionReport = new Models.PositionReport(baseAmount, quoteAmount, basePosition.heldAmount,
            quotePosition.heldAmount, baseValue, quoteValue, this._base.pair, this._base.exchange(), this._timeProvider.utcNow());

        if (this._report !== null &&
                Math.abs(positionReport.value - this._report.value) < 2e-6 &&
                Math.abs(positionReport.quoteValue - this._report.quoteValue) < 2e-2 &&
                Math.abs(positionReport.baseAmount - this._report.baseAmount) < 2e-6 &&
                Math.abs(positionReport.quoteAmount - this._report.quoteAmount) < 2e-2 &&
                Math.abs(positionReport.baseHeldAmount - this._report.baseHeldAmount) < 2e-6 &&
                Math.abs(positionReport.quoteHeldAmount - this._report.quoteHeldAmount) < 2e-2)
            return;

        this._report = positionReport;
        this.NewReport.trigger(positionReport);
        this._positionPublisher.publish(positionReport);
    };

    private handleOrderUpdate = (o: Models.OrderStatusReport) => {
        const qs = this._quoter.quotesActive(o.side);
        if (!qs.length || !this._report) return;
        var amount = o.side == Models.Side.Ask
          ? this._report.baseAmount + this._report.baseHeldAmount
          : this._report.quoteAmount + this._report.quoteHeldAmount;
        var heldAmount = 0;
        qs.forEach((q) => {
          amount -= q.quote.size * (o.side == Models.Side.Bid ? q.quote.price : 1);
          heldAmount += q.quote.size * (o.side == Models.Side.Bid ? q.quote.price : 1);
        });

        this.onPositionUpdate(new Models.CurrencyPosition(
          amount,
          heldAmount,
          o.side == Models.Side.Ask ? o.pair.base : o.pair.quote
        ));
    };

    constructor(private _timeProvider: Utils.ITimeProvider,
                private _base : Interfaces.IBroker,
                private _broker: Interfaces.IOrderBroker,
                private _quoter: Quoter.Quoter,
                private _fvEngine: FairValue.FairValueEngine,
                private _posGateway : Interfaces.IPositionGateway,
                private _positionPublisher : Publish.IPublish<Models.PositionReport>) {
        this._posGateway.PositionUpdate.on(this.onPositionUpdate);
        this._broker.OrderUpdate.on(this.handleOrderUpdate);
        this._fvEngine.FairValueChanged.on(() => this.onPositionUpdate(null));

        this._positionPublisher.registerSnapshot(() => (this._report === null ? [] : [this._report]));
    }
}

export class ExchangeBroker implements Interfaces.IBroker {
    private _log = log("ex:broker");

    public get hasSelfTradePrevention() {
        return this._baseGateway.hasSelfTradePrevention;
    }

    makeFee() : number {
        return this._baseGateway.makeFee();
    }

    takeFee() : number {
        return this._baseGateway.takeFee();
    }

    exchange() : Models.Exchange {
        return this._baseGateway.exchange();
    }

    public get pair() {
        return this._pair;
    }

    public get minTickIncrement() {
        return this._baseGateway.minTickIncrement;
    }

    public get minSize() {
        return this._baseGateway.minSize;
    }

    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    private mdConnected = Models.ConnectivityStatus.Disconnected;
    private oeConnected = Models.ConnectivityStatus.Disconnected;
    private _connectStatus = Models.ConnectivityStatus.Disconnected;
    public onConnect = (gwType : Models.GatewayType, cs : Models.ConnectivityStatus) => {
        if (gwType === Models.GatewayType.MarketData) {
            if (this.mdConnected === cs) return;
            this.mdConnected = cs;
        }

        if (gwType === Models.GatewayType.OrderEntry) {
            if (this.oeConnected === cs) return;
            this.oeConnected = cs;
        }

        const newStatus = this.mdConnected === Models.ConnectivityStatus.Connected && this.oeConnected === Models.ConnectivityStatus.Connected
            ? Models.ConnectivityStatus.Connected
            : Models.ConnectivityStatus.Disconnected;

        this._connectStatus = newStatus;
        this.ConnectChanged.trigger(newStatus);

        // this._log.info("Connection status changed :: %s :: (md: %s) (oe: %s)", Models.ConnectivityStatus[this._connectStatus],
            // Models.ConnectivityStatus[this.mdConnected], Models.ConnectivityStatus[this.oeConnected]);
        this._connectivityPublisher.publish(this.connectStatus);
    };

    public get connectStatus(): Models.ConnectivityStatus {
      return this._connectStatus;
    }

    constructor(
      private _pair: Models.CurrencyPair,
      private _mdGateway: Interfaces.IMarketDataGateway,
      private _baseGateway: Interfaces.IExchangeDetailsGateway,
      private _oeGateway: Interfaces.IOrderEntryGateway,
      private _connectivityPublisher: Publish.IPublish<Models.ConnectivityStatus>
    ) {
      this._mdGateway.ConnectChanged.on(s => {
        this.onConnect(Models.GatewayType.MarketData, s);
      });

      this._oeGateway.ConnectChanged.on(s => {
        this.onConnect(Models.GatewayType.OrderEntry, s)
      });

      this._connectivityPublisher.registerSnapshot(() => [this.connectStatus]);
    }
}
