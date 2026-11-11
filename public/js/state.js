// Shared app state. Plain object — the subscription layer that used to wrap
// it had zero subscribers, so it is gone.
// Immutable constants stay in their owning module.

// Built-in demo identity. If a slip would print with either of these still in
// place, it prints a shop name and GCash number that belong to nobody —
// receipts.js refuses those prints.
export const PLACEHOLDER_SHOP = Object.freeze({
  name: 'TechParts Repair & POS',
  number: '0917-123-4567'
});

const _state = {
  currentTab: 'pos',
  currentPriceTier: 'retail',
  currentPaymentMethod: 'cash',
  posBrandFilter: '',
  posCategoryFilter: '',
  posInStockOnly: true,
  inventoryItems: [],
  posCatalog: null, // set to inventoryItems after catalog load
  cart: [], // { id, is_labor, name, brand, model_name, part_type, price_retail, price_technician, unit_price, qty }
  activeDevice: null, // handset on bench (string or null)
  repairRefCode: null, // set by main.js bootstrap (newRepairRef)
  activeCustomerDetails: null,
  allCustomersCache: [],
  shopSettingsUnavailable: false, // last settings fetch failed: identity below is placeholder
  shopSettings: {
    gcash_name: PLACEHOLDER_SHOP.name,
    owner_name: '',
    shop_address: '',
    gcash_number: PLACEHOLDER_SHOP.number,
    gcash_qr_url: '',
    receipt_paper_width: '80mm',
    warranty_days: '7',
    warranty_policy_text: '7 Days Test Warranty for LCDs & Batteries. Physical crack, flex tear, water damage, or removed warranty seal voids warranty.',
    shop_footer_note: 'Thank you for your business! Please keep this receipt for warranty claims.'
  },
  // Session / role state. Token lives in memory + sessionStorage (survives F5,
  // dies on tab close). Elevation is memory-only with a 15-min TTL; a manager
  // session restored after F5 re-elevates on first use.
  sessionToken: null, // set by main.js from sessionStorage
  sessionActor: null, // {type:'manager'|'staff', id, name}
  elevationToken: null,
  elevationExpiresAt: 0,
  serviceMode: false,
  recoveryConfigured: false,
  loginGateResolve: null,
  loginGateTarget: null, // {staffId|null, name} — who the PIN row is for
  isManagerUnlocked: false,
  costPricesRevealed: false, // own display flag: hiding prices must not desync elevation gating
  pendingPinCallback: null,
  licenseRequired: false,
  inventoryRowsCache: [],
  saleInFlight: false,
  saleOpId: null,
  lastSaleForReprint: null,
  scanBuffer: '',
  lastScanKeyTime: 0,
  audioCtx: null,
  loginGatePickerInited: false,
  loginGateRendering: false,
  licenseCheckInFlight: false,
  confirmResolveFn: null,
  confirmInited: false,
  inputResolveFn: null,
  inputInited: false,
  lastFocusedEl: null,
  // Stack of open dialogs [{ id, prevFocus }] — Escape closes only the top
  // layer, everything beneath the top layer is made inert, and focus is
  // restored per layer on close.
  modalStack: [],
  catalogLoadFailed: false,
  currentTheme: null, // set by main.js from localStorage
};

export const S = _state;
