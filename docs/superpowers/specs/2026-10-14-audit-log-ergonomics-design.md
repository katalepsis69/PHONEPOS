# Audit Log Ergonomics & Visual Comfort Design Spec

**Date:** 2026-10-14  
**Scope:** `public/js/auth.js`, `public/index.html`, `public/styles.css`, `tests/pos-repair-counter-ergonomics.test.js`  
**Principles:** `/ponytail` (minimal targeted diffs, 0 dependencies), `/antislop` (R-02 ban on em dashes, C-1 to C-5 craftsmanship), `/antislop-ui` & `/antislop-human` (high contrast >= 4.5:1, tactile feedback).

---

## 1. Problem Statement

The Audit Log (`#view-audit`) provides forensic workstation tracking (PIN verification, elevation, inventory adjustments, and hash chain verification). However, several ergonomic and copy issues detract from visual quality:
1. **Em Dash Violations (Antislop R-02):**
   - Date group headers format as `TODAY — OCT 14, 2026` using em dashes (`—`).
   - Empty detail cells render an em dash `—` across 80%+ of entries.
   - The initial footer counter placeholder in `public/index.html` renders `—`.
2. **Date Header Hover State:**
   - Because `.ptable tbody tr:hover` was added system-wide, hovering across the table erroneously highlights date group headers (`.audit-date-row`) as if they were clickable log rows.
3. **Crude Empty State:**
   - Filtering with zero matching records prints an unstyled paragraph `<p class="foot-note">No entries for this filter.</p>` rather than the standardized `.empty` component used across the other views.

---

## 2. Proposed Design (Approach A: Balanced Workstation Polish)

### 2.1 Copy Hygiene & Anti-Slop Fixes
- In `public/js/auth.js`:
  - `auditDayLabel(dateStr)`: Format with a clean bullet separator:
    ```javascript
    return `${label} · ${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
    ```
  - `auditDetailCell(r)`: Return a subtle hyphen placeholder for empty details:
    ```javascript
    return '<span class="audit-empty">-</span>';
    ```
- In `public/index.html`:
  - Initialize the counter element with a standard hyphen:
    ```html
    <span class="foot-note" id="audit-count">-</span>
    ```

### 2.2 Table Hover Isolation & Date Grouping
- In `public/styles.css`:
  - Explicitly override row hover for date headers:
    ```css
    .ptable tbody tr.audit-date-row:hover {
      background-color: transparent;
    }
    ```
  - Refine `.audit-date-label` to provide crisp grouping separation.

### 2.3 Standardized Empty Component
- In `public/js/auth.js`, update the 0-rows branch:
  ```html
  <tr>
    <td colspan="4">
      <div class="empty">
        <div class="empty__icon"><i class="ph ph-shield-check w-5 h-5"></i></div>
        <div class="empty__title">No audit entries found</div>
        <p class="empty__body">No activity logged for this filter or date range.</p>
      </div>
    </td>
  </tr>
  ```

---

## 3. Verification Plan

1. **Automated Unit Tests:** Update `tests/pos-repair-counter-ergonomics.test.js` to assert:
   - Zero em dashes in audit log date labels, empty detail cells, and HTML count placeholder.
   - Hover isolation for `.audit-date-row`.
   - `.empty` component presence in `loadAuditLog`.
2. **Build Verification:** Execute `npm run build:css` and ensure clean compilation.
3. **Full Regression Run:** Execute `npm test` and verify 100% pass rate.
