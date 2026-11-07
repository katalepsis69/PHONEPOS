# Updater Loading States & Anti-Slop Ergonomics Design Spec

**Date:** 2026-10-15  
**Status:** Approved  
**Scope:** `public/index.html`, `public/styles.css`, `public/js/views/backoffice.js`, `tests/updater-ui.test.js`  
**Principles:**
- `/ponytail`: Zero dependencies, minimal targeted diff, YAGNI, no framework bloat, instant DOM updates.
- `/ui-design-spec`: Optical geometry, WCAG 2.2 AA accessibility, zero-deadzone hit targets, reduced-motion compliance.
- `/antislop` & `/antislop-ui`: Elimination of generic AI-slop tells (`ph-sparkle`), meaningful glyphs (`ph-arrow-circle-up`), purposeful state indicators only during real async network operations, no fake endless pulsing.

---

## 1. Problem Statement

1. **AI-Slop Iconography Tell (Antislop R-04 / R-13):**
   - The topbar status chip (`#update-status-chip`) and top notification banner (`#update-notification-banner`) use `<i class="ph ph-sparkle"></i>`.
   - Per `antislop-ui`, sparkles and stars are generic AI tropes that communicate nothing about software updates. Software updates represent upwards advancement or downloading, properly served by `ph-arrow-circle-up` or `ph-download-simple`.

2. **Missing In-Flight Loading Feedback:**
   - **Checking Phase:** When the operator clicks "Check for updates" in **Settings -> Data**, the button does not disable or spin, allowing multi-clicks while the GitHub Releases HTTP check is in flight.
   - **Download/Apply Phase:** When the operator confirms "Update Now" (from either the top banner or the Settings card), the banner's "Update Now" button lacks an ID, does not disable, and does not show loading status. Only `#btn-apply-update` in Settings changed text, leaving the banner button clickable and giving cashiers no visual confirmation of progress in the header.

---

## 2. Technical Architecture & Component Design

### 2.1 DOM & Copy Updates (`public/index.html`)

1. **Anti-Slop Glyphs:**
   - `#update-status-chip`: Replace `ph-sparkle` with `<i class="ph ph-arrow-circle-up w-3.5 h-3.5 text-emerald-400"></i>`.
   - `#update-notification-banner`: Replace `ph-sparkle` with `<i class="ph ph-arrow-circle-up text-emerald-400 w-4 h-4"></i>`.

2. **Synchronized Control Identifiers:**
   - In `#update-notification-banner`:
     - Assign `id="btn-banner-apply-update"` to the `"Update Now"` button.
     - Assign `id="btn-banner-dismiss-update"` to the `"Later"` dismiss button.
   - Wrap button text nodes in `<span>` tags to ensure clean text swapping alongside dynamic icons:
     ```html
     <button type="button" id="btn-banner-apply-update" class="btn-mini btn-primary" data-action="apply-update">
       <i class="ph ph-download-simple w-3.5 h-3.5"></i> <span>Update Now</span>
     </button>
     ```

3. **Screen Reader Live Announcements:**
   - Mark `#update-status-msg` with `aria-live="polite"` so state changes are announced cleanly to assistive tech.

### 2.2 Stylesheet Animation (`public/styles.css`)

Add lightweight `.animate-spin` utility honoring `prefers-reduced-motion`:

```css
@keyframes spin {
  to { transform: rotate(360deg); }
}

.animate-spin {
  animation: spin 0.8s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .animate-spin {
    animation: none;
  }
}
```

### 2.3 State Synchronization (`public/js/views/backoffice.js`)

1. **State Flags:**
   - `_updateCheckInFlight`: boolean to debounce concurrent checks.
   - `_updateApplyInFlight`: boolean to prevent double-invoking apply.

2. **Checking Phase:**
   - `checkForAppUpdates(silent)`:
     - Guard: `if (_updateCheckInFlight || _updateApplyInFlight) return;`
     - On non-silent check:
       - Disable `#btn-check-updates`, set `aria-busy="true"`.
       - Swap icon to `ph-arrows-clockwise animate-spin`, text to `"Checking…"`.
       - Set `#update-status-msg` to `"Checking GitHub Releases…"`.
     - In `finally`:
       - Restore `#btn-check-updates` enabled state, original icon, and `"Check for updates"` label.
       - Clear `_updateCheckInFlight`.

3. **Applying/Downloading Phase:**
   - `applyAppUpdate()`:
     - Guard: `if (_updateApplyInFlight) return;`
     - Manager PIN elevation and confirmation modal occur before in-flight lock.
     - Once confirmed:
       - `_updateApplyInFlight = true;`
       - Synchronously disable all update controls:
         - `#btn-apply-update`: `disabled = true`, `aria-busy = "true"`, spinner icon, text `"Downloading…"`.
         - `#btn-banner-apply-update`: `disabled = true`, `aria-busy = "true"`, spinner icon, text `"Downloading…"`.
         - `#btn-banner-dismiss-update`: `disabled = true` (cannot dismiss banner during active download).
         - `#btn-check-updates`: `disabled = true`.
         - `#update-status-chip`: update icon to spinner and text to `"Downloading update…"`.
         - `#update-status-msg`: `"Downloading & verifying update from GitHub Releases…"`.
     - In `finally`:
       - If update failed or running in dev mode:
         - Re-enable buttons, restore original icons and `"Update Now"` labels.
         - Clear `_updateApplyInFlight = false;`.
       - If success:
         - The full-screen restart screen renders and workstation restarts.

---

## 3. Verification Plan

1. **Automated Integration Tests (`tests/updater-ui.test.js`):**
   - Verify `ph-sparkle` is completely absent from `public/index.html`.
   - Verify `#update-status-chip` and `#update-notification-banner` use `ph-arrow-circle-up`.
   - Verify button IDs `#btn-banner-apply-update` and `#btn-banner-dismiss-update` exist.
   - Verify `aria-live="polite"` on `#update-status-msg`.
   - Verify `checkForAppUpdates` in-flight lock disables the check button during fetch.
   - Verify `applyAppUpdate` disables both the banner and settings apply buttons, updates text to `"Downloading…"`, and disables the banner dismiss button.
2. **Regression Check:**
   - Run `npm test` across all 470+ tests to confirm zero regressions.
   - Run `npm run build:css` to verify clean Tailwind build.
