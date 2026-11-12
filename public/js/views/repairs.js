// phone-repair-pos/public/js/views/repairs.js
// Repair ticket queue: the bench list the intake flow never had. Tickets are
// upserted by job reference from the POS (hold, sale, resume); this view
// tracks status, assignment, and pickup.
import { t } from '../i18n.js';
import { escHtml, fmtMoney, formatDateTime, showToast } from '../ui.js';

const STATUSES = ['intake', 'in_repair', 'ready', 'released', 'cancelled'];
const statusLabel = s => t(`repairs.status_${s}`, s);

let repairsState = { status: '', search: '', wired: false, timer: null };

export async function loadRepairs() {
  const list = document.getElementById('repairs-list');
  if (!list) return;
  const qs = new URLSearchParams();
  if (repairsState.status) qs.set('status', repairsState.status);
  if (repairsState.search) qs.set('search', repairsState.search);
  try {
    const res = await fetch('/api/repairs?' + qs);
    if (!res.ok) throw new Error('unavailable');
    renderRepairs(await res.json());
  } catch (_) {
    // Say the load failed; a quiet empty queue reads as "no work today".
    list.innerHTML = `<div class="empty"><div class="empty__icon"><i class="ph ph-wifi-slash w-5 h-5"></i></div><div class="empty__title">${t('repairs.load_failed_title', 'Repairs unavailable')}</div><p class="empty__body">${t('repairs.load_failed_body', 'Load failed; check the server and retry.')}</p></div>`;
  }
}

function statusChip(status) {
  const tone = { intake: 'info', in_repair: 'warn', ready: 'pos', released: '', cancelled: '' }[status] || '';
  return `<span class="tag tag--${tone}">${escHtml(statusLabel(status))}</span>`;
}

function renderRepairs(data) {
  const list = document.getElementById('repairs-list');
  if (!list) return;
  const counts = data.counts || {};
  document.querySelectorAll('#repairs-filter [data-status]').forEach(b => {
    const st = b.dataset.status || '';
    const n = st === '' ? STATUSES.reduce((a, s) => a + (counts[s] || 0), 0) - (counts.released || 0) - (counts.cancelled || 0) : (counts[st] || 0);
    const label = st === '' ? t('repairs.filter_open', 'Open') : statusLabel(st);
    b.textContent = st === '' ? `${label} · ${n}` : `${label} ${n}`;
    b.classList.toggle('is-active', repairsState.status === st);
  });

  const rows = data.repairs || [];
  list.innerHTML = rows.length
    ? rows.map(r => `
      <div class="kv items-start">
        <div class="min-w-0 flex-1">
          <span class="block font-bold font-mono">${escHtml(r.ref_code)}</span>
          <span class="block truncate"><strong>${escHtml(r.customer_name)}</strong>${r.customer_phone ? ` <span class="foot-note font-mono">${escHtml(r.customer_phone)}</span>` : ''}</span>
          <span class="block foot-note truncate">${escHtml(r.device || '')}${r.imei ? ` · IMEI ${escHtml(r.imei)}` : ''}</span>
          ${r.issue_note ? `<span class="block foot-note truncate">${escHtml(r.issue_note)}</span>` : ''}
          <span class="block foot-note font-mono">${escHtml(formatDateTime(r.updated_at))}${r.assigned_to ? ` · ${escHtml(r.assigned_to)}` : ''}${r.sale_id ? ` · ${t('repairs.billed', 'billed')}` : ''}</span>
        </div>
        <div class="text-right shrink-0 flex flex-col items-end gap-1">
          ${r.estimate > 0 ? `<span class="font-mono font-bold">${fmtMoney(r.estimate)}</span>` : ''}
          ${statusChip(r.status)}
          <label class="sr-only" for="repair-status-${r.id}">${t('repairs.set_status', 'Set status')}</label>
          <select id="repair-status-${r.id}" class="select-sm" data-repair-status="${r.id}" data-prev="${escHtml(r.status)}">
            ${STATUSES.map(s => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${escHtml(statusLabel(s))}</option>`).join('')}
          </select>
        </div>
      </div>`).join('')
    : `<div class="empty"><div class="empty__icon"><i class="ph ph-wrench w-5 h-5"></i></div><div class="empty__title">${t('repairs.empty_title', 'No repair tickets here')}</div><p class="empty__body">${t('repairs.empty_body', 'Hold a job on the counter or take an intake; it shows up here by reference.')}</p></div>`;
}

export function wireRepairsView() {
  if (repairsState.wired || typeof document === 'undefined') return;
  repairsState.wired = true;
  const filter = document.getElementById('repairs-filter');
  if (filter) filter.addEventListener('click', e => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    repairsState.status = b.dataset.status;
    loadRepairs();
  });
  const search = document.getElementById('repairs-search');
  if (search) search.addEventListener('input', () => {
    clearTimeout(repairsState.timer);
    repairsState.timer = setTimeout(() => {
      repairsState.search = search.value.trim();
      loadRepairs();
    }, 250);
  });
  const list = document.getElementById('repairs-list');
  if (list) list.addEventListener('change', async e => {
    const select = e.target.closest('[data-repair-status]');
    if (!select) return;
    const id = select.dataset.repairStatus;
    try {
      const res = await fetch(`/api/repairs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: select.value })
      });
      if (!res.ok) throw new Error('failed');
      showToast(t('repairs.status_saved', 'Status saved.'), 'pos');
      loadRepairs();
    } catch (_) {
      showToast(t('repairs.status_failed', 'Could not save the status.'), 'error');
      select.value = select.dataset.prev; // snap back to the server's truth
      loadRepairs();
    }
  });
}
