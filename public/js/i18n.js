// Lightweight vanilla i18n dictionary for POS interface (zero external dependencies)
export const I18N = {
  en: {
    // Topbar & Nav
    'nav.new_repair': 'New repair',
    'nav.counter': 'Counter',
    'nav.pos': 'Repair counter',
    'nav.customers': 'Customers',
    'nav.stock': 'Stock & service',
    'nav.inventory': 'Inventory',
    'nav.returns': 'Warranty & returns',
    'nav.records': 'Records',
    'nav.sales': 'Sales history',
    'nav.reports': 'Reports & profit',
    'nav.audit': 'Audit log',
    'nav.open_drawer': 'Open drawer',
    'nav.close_drawer': 'Close drawer',
    'nav.reprint': 'Reprint',
    'nav.logout': 'Log out',
    'nav.offline': 'Offline ready',

    // Titles
    'title.pos': 'Repair counter',
    'title.credits': 'Customers',
    'title.inventory': 'Parts inventory',
    'title.returns': 'Warranty & returns',
    'title.sales': 'Sales history',
    'title.dashboard': 'Reports & profit',
    'title.audit': 'Audit log',

    // Inventory & Bulk
    'inv.add_part': 'Add New Phone Part',
    'inv.import': 'Import',
    'inv.bulk_edit': 'Bulk Edit',
    'inv.clear': 'Clear',
    'inv.th_model': 'Brand / Model',
    'inv.th_type': 'Part Type / Screen Tech',
    'inv.th_cost': 'Capital (₱)',
    'inv.th_retail': 'Retail (₱)',
    'inv.th_wholesale': 'Wholesale (₱)',
    'inv.th_stock': 'Stock Qty',
    'inv.th_status': 'Status',
    'inv.th_actions': 'Actions',

    // POS & Counter
    'pos.intake_placeholder': 'Search parts by name, model, brand, or SKU...',
    'pos.cart_empty': 'No parts in current repair',
    'pos.hold': 'Hold job',
    'pos.clear': 'Clear order',
    'pos.collect': 'Complete Repair & Collect',

    // Common actions & counters
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.save_changes': 'Save Changes',
    'common.apply': 'Apply',
    'common.selected': 'selected',
    'common.actions': 'Actions',

    // Bulk Edit Modal
    'bulk.title': 'Bulk Edit Selected Parts',
    'bulk.action_label': 'Action to perform',
    'bulk.opt_adjust_price': 'Adjust prices (+/- amount or %)',
    'bulk.opt_recalculate': 'Recalculate prices from capital (% markup)',
    'bulk.opt_update_fields': 'Update details (supplier, location, min alert)',
    'bulk.opt_archive': 'Archive selected parts',
    'bulk.opt_unarchive': 'Restore / unarchive selected parts',
    'bulk.price_target': 'Price target',
    'bulk.target_both': 'Both Retail & Wholesale',
    'bulk.target_retail': 'Retail only',
    'bulk.target_wholesale': 'Wholesale only',
    'bulk.adj_mode': 'Adjustment mode',
    'bulk.mode_amount': 'Fixed amount (+/- PHP)',
    'bulk.mode_pct': 'Percentage (+/- %)',
    'bulk.adj_value': 'Adjustment value',
    'bulk.adj_val_ph': 'e.g. 50, -20, or 10',
    'bulk.adj_note': 'Use positive numbers to increase (e.g. 50) and negative to discount (e.g. -20).',
    'bulk.recalc_note': 'Recalculates selling prices from each selected part\'s Capital.',
    'bulk.retail_markup': 'Retail Markup (%)',
    'bulk.retail_formula': 'Retail = Capital + Retail %',
    'bulk.wholesale_markup': 'Wholesale Markup (%)',
    'bulk.wholesale_formula': 'Wholesale = Capital + Wholesale %',
    'bulk.fields_note': 'Leave blank any fields you do not wish to change.',
    'bulk.supplier': 'Supplier',
    'bulk.unchanged_ph': 'Leave blank to keep unchanged',
    'bulk.location': 'Storage location / Shelf',
    'bulk.min_alert': 'Min stock alert',
    'bulk.archive_info': 'Selected parts will be hidden from the active catalog and POS. Stock quantity and ledger history will be preserved.',
    'bulk.unarchive_info': 'Selected parts will be restored to the active catalog and POS.',
    'bulk.apply': 'Apply Changes',
    'bulk.applying': 'Applying...',
    'bulk.none_selected': 'Select one or more parts first',
    'bulk.applied': 'Bulk edit applied to',
    'bulk.replayed': 'Bulk edit was already applied (duplicate submit)',
    'update.now': 'Update Now',
    'update.check': 'Check for Updates',
    'update.downloading_btn': 'Downloading…',
    'update.downloading_chip': 'Downloading update…',
    'update.available': 'A new version (%s) is available!',
    'drawer.open': 'OPEN',
    'drawer.float': 'Float',
    'stub.no_identity': 'Claim stub not printed: shop identity is still the placeholder. Save real shop details in Settings.',
    'stub.nothing': 'Enter a device, job note, or part before printing a claim stub',
    'stub.fallback': 'Printed through the browser dialog: this window was opened manually. Reopen the POS from its desktop icon for one-touch printing.',
    'bulk.parts_count': 'part(s)',
    'bulk.failed': 'Bulk edit failed',
    'bulk.no_updated': 'No parts were updated (selected parts may have zero capital)',

    // Inventory Stats & Type Filter
    'inv.stat_parts': 'Parts in catalog',
    'inv.stat_units': 'units on hand',
    'inv.stat_in_stock': 'In stock',
    'inv.stat_healthy': 'healthy levels',
    'inv.stat_low_stock': 'Low stock',
    'inv.stat_reorder': 'at or below reorder point',
    'inv.stat_out_stock': 'Out of stock',
    'inv.stat_restock': 'needs restock',
    'inv.all_types': 'All Part Types',

    // Add & Edit Part Modals
    'part.add_title': 'Add Phone Part',
    'part.edit_title': 'Edit Part',
    'part.brand': 'Brand *',
    'part.model': 'Model Name *',
    'part.type': 'Part Type / Screen Spec *',
    'part.sku': 'SKU / Barcode',
    'part.supplier': 'Supplier',
    'part.location': 'Location',
    'part.cost': 'Capital (₱) *',
    'part.retail': 'Retail (₱) *',
    'part.wholesale': 'Wholesale (₱) *',
    'part.stock': 'Stock Qty *',
    'part.set_stock': 'Set stock to *',
    'part.min_alert': 'Min Stock Alert',
    'part.save': 'Save Part',

    // Stock Adjust Modal
    'stock.adjust_title': 'Adjust / Receive Stock',
    'stock.delta': 'Amount (+/-) *',
    'stock.reason': 'Reason *',
    'stock.reason_receive': 'Receive stock',
    'stock.reason_correction': 'Correction (stock count)',
    'stock.reason_damage': 'Damage',
    'stock.reason_loss': 'Loss',
    'stock.note': 'Note',

    // Import & Inventory Hints
    'inv.import_tt': 'Import parts from Excel or CSV (uses markup from Settings > Store)',
    'inv.import_note': 'Upload Excel or CSV. Blank prices are calculated from capital using store markup (set in Store tab).',
    'inv.import_auto_note': 'Blank prices use store markup (%s% retail, %s% wholesale) for new parts, and for existing parts when their capital changed. Set in Settings > Store.',
    'inv.settings_store': 'Settings > Store',
    'inv.open_store_settings': 'Open Store Settings to adjust default markup',
    'inv.bulk_hint': 'Check parts to edit prices, recalculate markup, or change location.',
    'inv.delete_has_sales': 'Parts with sales history cannot be deleted. Archive the part instead to hide it from the counter.',
    'inv.missing_cols': 'Missing required columns',
    'inv.check_template_hint': 'Make sure your headers match the template format.',
    'inv.download_template': 'Download template',
    'inv.cannot_import': 'Missing columns',
    'inv.no_data_rows': 'The file has no data rows',
    'inv.import_confirm_title': 'Confirm import',
    'inv.parts_count': 'part(s)',
    'part.gen_barcode': 'Create barcode',

    // POS & Counter Hints
    'pos.tier_retail_tt': 'Regular retail price',
    'pos.tier_wholesale_tt': 'Wholesale price',
    'pos.cust_search_ph': 'Customer name or phone (shows unpaid balance)',
    'pos.credit_require_name': 'Requires a customer name and phone number.',
    'pos.claim_stub_tt': 'Print claim stub before repair starts',
    'pos.search_ph': 'Scan barcode or type part (press Enter to add)',

    // Credit Settlement Hints
    'credit.settle_partial_note': 'Enter amount to pay. Partial payments are accepted.',
    'credit.pin_needed': 'Payments over %s require Manager PIN.',

    // Returns Hints
    'returns.search_ph': 'Search by receipt number, customer name, or barcode',
    'returns.restock_note': 'Returning a part puts it back into inventory stock.',

    // Settings Hints
    'settings.markup_note': 'Markup applied when importing parts with blank prices or recalculating in bulk.'
  },
  tl: {
    // Topbar & Nav
    'nav.new_repair': 'Bagong repair',
    'nav.counter': 'Kaha',
    'nav.pos': 'Talaan ng repair',
    'nav.customers': 'Mga Kostumer',
    'nav.stock': 'Imbentaryo & Serbisyo',
    'nav.inventory': 'Mga Piyesa',
    'nav.returns': 'Garantiya & Balik',
    'nav.records': 'Mga Rekord',
    'nav.sales': 'Kasaysayan ng Benta',
    'nav.reports': 'Ulat & Kita',
    'nav.audit': 'Talaan ng Aktibidad',
    'nav.open_drawer': 'Buksan ang kaha',
    'nav.close_drawer': 'Isara ang kaha',
    'nav.reprint': 'I-print muli',
    'nav.logout': 'Mag-log out',
    'nav.offline': 'Handa offline',

    // Titles
    'title.pos': 'Talaan ng repair',
    'title.credits': 'Mga Kostumer',
    'title.inventory': 'Imbentaryo ng Piyesa',
    'title.returns': 'Garantiya & Balik',
    'title.sales': 'Kasaysayan ng Benta',
    'title.dashboard': 'Ulat & Kita',
    'title.audit': 'Talaan ng Aktibidad',

    // Inventory & Bulk
    'inv.add_part': 'Magdagdag ng Piyesa',
    'inv.import': 'Mag-import',
    'inv.bulk_edit': 'Sabayang Edit',
    'inv.clear': 'Alisin',
    'inv.th_model': 'Brand / Modelo',
    'inv.th_type': 'Uri ng Piyesa',
    'inv.th_cost': 'Puhunan (₱)',
    'inv.th_retail': 'Retail (₱)',
    'inv.th_wholesale': 'Wholesale (₱)',
    'inv.th_stock': 'Dami sa Stock',
    'inv.th_status': 'Katayuan',
    'inv.th_actions': 'Aksyon',

    // POS & Counter
    'pos.intake_placeholder': 'Maghanap ng piyesa gamit ang pangalan, modelo, o SKU...',
    'pos.cart_empty': 'Walang piyesa sa repair na ito',
    'pos.hold': 'I-hold ang trabaho',
    'pos.clear': 'Burahin ang order',
    'pos.collect': 'Singilin at Tapusin',

    // Common actions & counters
    'common.cancel': 'Kanselahin',
    'common.save': 'I-save',
    'common.save_changes': 'I-save ang Pagbabago',
    'common.apply': 'Ipatupad',
    'common.selected': 'napili',
    'common.actions': 'Mga Aksyon',

    // Bulk Edit Modal
    'bulk.title': 'Sabayang Pag-edit ng Piyesa',
    'bulk.action_label': 'Piliin ang gagawin',
    'bulk.opt_adjust_price': 'I-adjust ang presyo (+/- halaga o %)',
    'bulk.opt_recalculate': 'Kalkulahin muli mula sa puhunan (% markup)',
    'bulk.opt_update_fields': 'I-update ang detalye (supplier, lokasyon, min alert)',
    'bulk.opt_archive': 'I-archive ang napiling mga piyesa',
    'bulk.opt_unarchive': 'Ibalik / i-unarchive ang napiling mga piyesa',
    'bulk.price_target': 'Presyong babaguhin',
    'bulk.target_both': 'Parehong Retail & Wholesale',
    'bulk.target_retail': 'Retail lamang',
    'bulk.target_wholesale': 'Wholesale lamang',
    'bulk.adj_mode': 'Paraan ng pag-adjust',
    'bulk.mode_amount': 'Tiyak na halaga (+/- PHP)',
    'bulk.mode_pct': 'Porsyento (+/- %)',
    'bulk.adj_value': 'Halaga ng adjustment',
    'bulk.adj_val_ph': 'hal. 50, -20, o 10',
    'bulk.adj_note': 'Gumamit ng positibong numero para magtaas (hal. 50) at negatibo para magbawas (hal. -20).',
    'bulk.recalc_note': 'Kalkulahin muli ang presyo ng benta mula sa puhunan ng bawat napiling piyesa.',
    'bulk.retail_markup': 'Tubo sa Retail (%)',
    'bulk.retail_formula': 'Retail = Puhunan + Retail %',
    'bulk.wholesale_markup': 'Tubo sa Wholesale (%)',
    'bulk.wholesale_formula': 'Wholesale = Puhunan + Wholesale %',
    'bulk.fields_note': 'Iwang blangko ang mga field na ayaw baguhin.',
    'bulk.supplier': 'Supplier',
    'bulk.unchanged_ph': 'Iwang blangko kung walang pagbabago',
    'bulk.location': 'Lokasyon / Istante',
    'bulk.min_alert': 'Babala sa mababang stock',
    'bulk.archive_info': 'Maitatago ang napiling mga piyesa mula sa aktibong katalogo at POS. Mananatili ang stock at kasaysayan sa ledger.',
    'bulk.unarchive_info': 'Ibabalik ang napiling mga piyesa sa aktibong katalogo at POS.',
    'bulk.apply': 'Ipatupad ang Pagbabago',
    'bulk.applying': 'Ipinapatupad...',
    'bulk.none_selected': 'Pumili muna ng isa o higit pang piyesa',
    'bulk.applied': 'Matagumpay na na-edit ang',
    'bulk.replayed': 'Naipatupad na ang bulk edit (dobolong pagsubmit)',
    'update.now': 'I-update Na',
    'update.check': 'Tingnan ang Update',
    'update.downloading_btn': 'Nagda-download…',
    'update.downloading_chip': 'Nagda-download ng update…',
    'update.available': 'May bagong bersyon (%s)!',
    'drawer.open': 'BUKAS',
    'drawer.float': 'Float',
    'stub.no_identity': 'Hindi na-print ang claim stub: ang identity ng tindahan ay placeholder pa rin. I-save ang totoong detalye sa Settings.',
    'stub.nothing': 'Maglagay ng device, job note, o parte bago mag-print ng claim stub',
    'stub.fallback': 'Na-print sa browser dialog: binuksan nang mano-ano ang window. Buksan muli ang POS mula sa desktop icon para sa one-touch printing.',
    'bulk.parts_count': 'piyesa',
    'bulk.failed': 'Hindi nagtagumpay ang bulk edit',
    'bulk.no_updated': 'Walang piyesang nabago (maaaring zero ang puhunan ng napiling piyesa)',

    // Inventory Stats & Type Filter
    'inv.stat_parts': 'Piyesa sa katalogo',
    'inv.stat_units': 'piraso na hawak',
    'inv.stat_in_stock': 'May stock',
    'inv.stat_healthy': 'sapat na lebel',
    'inv.stat_low_stock': 'Mababang stock',
    'inv.stat_reorder': 'dapat nang mag-reorder',
    'inv.stat_out_stock': 'Ubos na ang stock',
    'inv.stat_restock': 'kailangan ng restock',
    'inv.all_types': 'Lahat ng Uri ng Piyesa',

    // Add & Edit Part Modals
    'part.add_title': 'Magdagdag ng Piyesa',
    'part.edit_title': 'I-edit ang Piyesa',
    'part.brand': 'Brand *',
    'part.model': 'Pangalan ng Modelo *',
    'part.type': 'Uri ng Piyesa / Detalye ng Screen *',
    'part.sku': 'SKU / Barcode',
    'part.supplier': 'Supplier',
    'part.location': 'Lokasyon',
    'part.cost': 'Puhunan (₱) *',
    'part.retail': 'Retail (₱) *',
    'part.wholesale': 'Wholesale (₱) *',
    'part.stock': 'Dami sa Stock *',
    'part.set_stock': 'Itakda ang stock sa *',
    'part.min_alert': 'Babala sa Mababang Stock',
    'part.save': 'I-save ang Piyesa',

    // Stock Adjust Modal
    'stock.adjust_title': 'Mag-adjust / Tumanggap ng Stock',
    'stock.delta': 'Dami (+/-) *',
    'stock.reason': 'Dahilan *',
    'stock.reason_receive': 'Pumasok na stock (Receive)',
    'stock.reason_correction': 'Pagwawasto (Bilang ng stock)',
    'stock.reason_damage': 'Sira (Damage)',
    'stock.reason_loss': 'Nawala (Loss)',
    'stock.note': 'Tala / Note',

    // Import & Inventory Hints
    'inv.import_tt': 'Mag-import ng piyesa mula sa Excel o CSV (gamit ang markup sa Settings > Store)',
    'inv.import_note': 'Mag-upload ng Excel o CSV. Ang blangkong presyo ay kukuwentahin mula sa puhunan (mababago sa Store tab).',
    'inv.import_auto_note': 'Ang blangkong presyo ay gagamit ng markup ng tindahan (%s% retail, %s% wholesale) para sa mga bagong parte, at sa mga parte kapag nagbago ang capital. Mababago sa Settings > Store.',
    'inv.settings_store': 'Settings > Store',
    'inv.open_store_settings': 'Buksan ang Store Settings para baguhin ang markup',
    'inv.bulk_hint': 'Lagyan ng tsek ang mga piyesa para magbago ng presyo, magkuwenta ng tubo, o magpalit ng pwesto.',
    'inv.delete_has_sales': 'Hindi maaaring burahin ang piyesang may benta na. I-archive ito para maitago sa counter.',
    'inv.missing_cols': 'Kulang ang kailangang columns',
    'inv.check_template_hint': 'Siguraduhing tugma ang headers sa template.',
    'inv.download_template': 'I-download ang template',
    'inv.cannot_import': 'May kulang na columns',
    'inv.no_data_rows': 'Walang datos ang file',
    'inv.import_confirm_title': 'Kumpirmahin ang import',
    'inv.parts_count': 'piyesa',
    'part.gen_barcode': 'Gumawa ng barcode',

    // POS & Counter Hints
    'pos.tier_retail_tt': 'Karaniwang presyo sa retail',
    'pos.tier_wholesale_tt': 'Presyong wholesale',
    'pos.cust_search_ph': 'Pangalan o cellphone (makikita ang utang)',
    'pos.credit_require_name': 'Kailangan ng pangalan at numero ng customer.',
    'pos.claim_stub_tt': 'Mag-print ng stub bago simulan ang repair',
    'pos.search_ph': 'I-scan ang barcode o i-type ang piyesa (Enter para idagdag)',

    // Credit Settlement Hints
    'credit.settle_partial_note': 'Ilagay ang ibabayad. Pwedeng magbayad nang hulugan.',
    'credit.pin_needed': 'Ang bayad na higit sa %s ay kailangan ng Manager PIN.',

    // Returns Hints
    'returns.search_ph': 'Maghanap gamit ang resibo, pangalan, o barcode',
    'returns.restock_note': 'Ang isinauling piyesa ay ibabalik sa stock ng imbentaryo.',

    // Settings Hints
    'settings.markup_note': 'Tubong idaragdag kapag nag-import ng blangkong presyo o nagkuwenta nang maramihan.'
  }
};

export function getLang() {
  return localStorage.getItem('pos_lang') || 'en';
}

export function t(key, fallback = '') {
  const lang = getLang();
  return I18N[lang]?.[key] || I18N.en[key] || fallback || key;
}

export function applyLanguage(lang) {
  const active = lang || getLang();
  localStorage.setItem('pos_lang', active);
  document.documentElement.lang = active;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (I18N[active]?.[key]) {
      el.textContent = I18N[active][key];
    } else if (I18N.en[key]) {
      el.textContent = I18N.en[key];
    }
  });

  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.dataset.i18nPh;
    if (I18N[active]?.[key]) {
      el.placeholder = I18N[active][key];
    } else if (I18N.en[key]) {
      el.placeholder = I18N.en[key];
    }
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    const val = I18N[active]?.[key] || I18N.en[key];
    if (val) {
      el.title = val;
      el.setAttribute('aria-label', val);
    }
  });

  const toggleLabel = document.getElementById('lang-toggle-label');
  if (toggleLabel) {
    toggleLabel.textContent = active === 'tl' ? 'EN' : 'TL';
  }
  const toggleBtn = document.getElementById('lang-toggle-btn');
  if (toggleBtn) {
    toggleBtn.setAttribute('title', active === 'tl' ? 'Switch to English' : 'Lumipat sa Tagalog');
    toggleBtn.setAttribute('aria-label', active === 'tl' ? 'Switch to English' : 'Lumipat sa Tagalog');
  }

  const pageTitle = document.getElementById('page-title');
  const currentTab = document.body.dataset.tab;
  if (pageTitle && currentTab && I18N[active]?.[`title.${currentTab}`]) {
    pageTitle.textContent = I18N[active][`title.${currentTab}`];
  }

  const bulkCount = document.getElementById('inv-bulk-count');
  if (bulkCount) {
    const num = parseInt(bulkCount.textContent, 10) || 0;
    bulkCount.textContent = `${num} ${I18N[active]?.['common.selected'] || I18N.en['common.selected']}`;
  }
  const bulkBadge = document.getElementById('bulk-edit-badge');
  if (bulkBadge) {
    const num = parseInt(bulkBadge.textContent, 10) || 0;
    bulkBadge.textContent = `${num} ${I18N[active]?.['common.selected'] || I18N.en['common.selected']}`;
  }
}

export function toggleLanguage() {
  const next = getLang() === 'tl' ? 'en' : 'tl';
  applyLanguage(next);
  return next;
}
