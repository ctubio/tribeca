import {Component, Input} from '@angular/core';

import {GridOptions, GridApi, RowNode} from 'ag-grid-community';

import {Shared, Models} from 'lib/K';

@Component({
  selector: 'wallets',
  template: `<div hidden="true">
    <markets *ngIf="markets_view"
      (rendered)="onRendered($event)"
      [settings]="settings"
      [markets]="markets"
      [market]="market"></markets>
  </div>
  <ag-grid-angular id="portfolios"
    class="ag-theme-alpine ag-theme-big"
    style="width: 100%;"
    (window:resize)="onGridReady($event)"
    (filterChanged)="onFilterChanged($event)"
    (gridReady)="onGridReady($event)"
    (rowClicked)="onRowClicked($event)"
    [gridOptions]="grid"></ag-grid-angular>`
})
export class WalletsComponent {

  private deferredRender: any = null;

  private markets_view: boolean = false;
  private market: any = null;

  private selection: string = "";

  @Input() markets: any;

  @Input() set wallets(o: any) {
    this.addRowData(o);
  };

  @Input() settings: Models.PortfolioParameters;

  private onRendered = ($event) => {
    if (this.deferredRender) setTimeout(this.deferredRender, 0);
  };

  private onRowClicked = ($event) => {
    if (!$event.data.currency) return;
    if (this.selection == $event.data.currency) {
      this.api.deselectAll();
      this.selection = "";
    }
    else this.selection = $event.data.currency;
  };

  private api: GridApi;

  private grid: GridOptions = <GridOptions>{
    overlayLoadingTemplate: `<span class="ag-overlay-no-rows-center">missing data</span>`,
    overlayNoRowsTemplate: `<span class="ag-overlay-no-rows-center">missing data</span>`,
    defaultColDef: { sortable: true, resizable: true, flex: 1 },
    rowHeight:35,
    headerHeight:35,
    domLayout: 'autoHeight',
    animateRows:true,
    rowSelection: {
      mode: "singleRow",
      checkboxes: false,
      enableClickSelection: true
    },
    enableCellTextSelection: true,
    onSelectionChanged: () => {
      this.markets_view = false;
      this.market = null;
      this.api.forEachNode((node: RowNode) => {
        node.setRowHeight(this.grid.rowHeight);
      });
      var node: any = this.api.getSelectedNodes().reverse().pop();
      if (!node) return this.api.onRowHeightChanged();
      this.deferredRender = () => {
        var main = document.getElementById('portfolios');
        var detail = document.getElementById('markets');
        if (main && detail) {
          var isdark = main.classList.value.indexOf('-dark');
          detail.classList.add('ag-theme-alpine' + (isdark?'-dark':''));
          detail.classList.remove('ag-theme-alpine' + (isdark?'':'-dark'));
          var row = document.querySelector("#portfolios div[row-id='" + node.data.currency + "'] div[aria-colindex='4']");
          if (row) row.appendChild(detail);
          var style = (<HTMLElement>detail).style;
          node.setRowHeight(
            this.grid.rowHeight
            + parseInt(style.marginTop)
            + parseInt(style.marginBottom)
            + (<HTMLElement>document.querySelector('#markets div.ag-root-wrapper')).offsetHeight
          );
          this.api.onRowHeightChanged();
        }
      };
      setTimeout(() => {
        this.markets_view = true;
        setTimeout(() => {
          this.market = node.data.currency;
        }, 0);
      }, 0);
    },
    isExternalFilterPresent: () => !this.settings.zeroed,
    doesExternalFilterPass: (node) => (
      this.settings.zeroed || parseFloat(node.data.total) > 0.0000001
    ),
    getRowId: (params: any) => params.data.currency || "TOTALS",
    columnDefs: [{
      width: 220,
      field: 'held',
      headerName: 'held',
      type: 'rightAligned',
      cellRenderer: (params) => params.node.rowPinned == 'top'
        ? ``
        : `<span class="val">` + params.value + `</span>`,
      cellClassRules: {
        'text-muted': '!parseFloat(x)',
        'up-data': 'data.dir_held == "up-data"',
        'down-data': 'data.dir_held == "down-data"'
      },
      comparator: Shared.comparator
    }, {
      width: 220,
      field: 'amount',
      headerName: 'available',
      type: 'rightAligned',
      cellRenderer: (params) => params.node.rowPinned == 'top'
        ? ``
        : `<span class="val">` + params.value + `</span>`,
      cellClassRules: {
        'text-muted': '!parseFloat(x)',
        'up-data': 'data.dir_amount == "up-data"',
        'down-data': 'data.dir_amount == "down-data"'
      },
      comparator: Shared.comparator
    }, {
      width: 220,
      field: 'total',
      headerName: 'total',
      type: 'rightAligned',
      cellRenderer: (params) => params.node.rowPinned == 'top'
        ? ``
        : `<span class="val">` + params.value + `</span>`,
      cellClassRules: {
        'text-muted': '!parseFloat(x)',
        'up-data': 'data.dir_total == "up-data"',
        'down-data': 'data.dir_total == "down-data"'
      },
      comparator: Shared.comparator
    }, {
      width: 130,
      field: 'currency',
      headerName: 'currency',
      filter: true,
      cellRenderer: (params) => params.node.rowPinned == 'top'
        ? ``
        : '<span class="row_title"><i class="beacon sym-_default-s sym-' + params.value.toLowerCase() + '-s" ></i> ' + params.value + '</span>',
      cellClassRules: {
        'text-muted': '!parseFloat(data.total)'
      }
    }, {
      width: 220,
      field: 'price',
      headerName: 'price',
      type: 'rightAligned',
      cellRenderer: (params) => params.node.rowPinned == 'top'
        ? `<span id="price_pin"></span>`
        : `<span class="val">` + params.value + `</span>`,
      cellClassRules: {
        'text-muted': '!parseFloat(x)',
        'up-data': 'data.dir_price == "up-data"',
        'down-data': 'data.dir_price == "down-data"'
      },
      comparator: Shared.comparator
    }, {
      width: 220,
      field: 'balance',
      headerName: 'balance',
      sort: 'desc',
      type: 'rightAligned',
      cellRenderer: (params) => params.node.rowPinned == 'top'
        ? `<span class="kira" id ="balance_pin"></span><span id="total_pin" class="balance_percent"></span>`
        : `<span class="val">` + params.value + `</span>`
            + `<small class="balance_percent">` + (params.data.balance_percent||'0.00') + `</small>`,
      cellClassRules: {
        'text-muted': '!parseFloat(x)',
        'up-data': 'data.dir_balance == "up-data"',
        'down-data': 'data.dir_balance == "down-data"'
      },
      comparator: Shared.comparator
    }]
  };

  private onGridReady($event: any) {
    if ($event.api) this.api = $event.api;
    Shared.currencyHeaders(this.api, this.settings.currency, this.settings.currency, true);
  };

  private onFilterChanged = ($event: any) => {
    if (!this.selection) return;
    var node: any = this.api.getRowNode(this.selection);
    if (node && !this.grid.doesExternalFilterPass(node))
      this.onRowClicked({data:{currency:this.selection}});
  };

  private addRowData = (o: any) => {
    if (!this.api) return;
    var sum = 0;
    if (o === null) {
      this.api.setGridOption('rowData', []);
      this.selection = "";
    }
    else o.forEach(o => {
      const amount  = Shared.str(o.wallet.amount,                 8);
      const held    = Shared.str(o.wallet.held,                   8);
      const total   = Shared.str(o.wallet.amount + o.wallet.held, 8);
      const balance = Shared.str(o.wallet.value,                  8);
      const price   = Shared.str(o.price,                         8);
      sum += o.wallet.value;
      var node: any = this.api.getRowNode(o.wallet.currency);
      if (!node)
        this.api.applyTransaction({add: [{
          currency: o.wallet.currency,
          amount: amount,
          held: held,
          total: total,
          balance: balance,
          price: price
        }]});
      else
        this.api.flashCells({
          rowNodes: [node],
          columns: [].concat(Shared.resetRowData('balance', balance, node))
                     .concat(Shared.resetRowData('price',   price,   node))
                     .concat(Shared.resetRowData('amount',  amount,  node))
                     .concat(Shared.resetRowData('held',    held,    node))
                     .concat(Shared.resetRowData('total',   total,   node))
        });
    });

    this.api.onFilterChanged();

    if (!this.api.getSelectedNodes().length)
      this.api.onSortChanged();

    
    this.api.forEachNode((node: RowNode) => {
      node.data.balance_percent = Shared.str(Shared.num(node.data.balance) / sum * 100, 2);
    });

    if (!this.api.getPinnedTopRowCount()) {
      this.api.setGridOption('pinnedTopRowData', [{}]);
    }

    var el = document.getElementById('balance_pin');
    if (el) {
      el.innerHTML = Shared.str(sum, 8);
      var sel = document.getElementById("portfolios_settings");
      if (sel) {
        var parent = el.closest('.ag-cell') as HTMLElement;
        sel.style.right = (20 + (parent.offsetWidth || 250)) + 'px';
      }
    }
  };
};