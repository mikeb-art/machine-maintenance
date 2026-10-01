# machine-maintenance

WS Display machine maintenance tracker. **Archived Sep 30, 2026.** Replaced by EquipFlow:
https://equipflow-lemon.vercel.app/maintenance/ and https://equipflow-lemon.vercel.app/printer-maintenance/

- `index.html` (site root) now forwards to EquipFlow.
- The full manual sign-off app, including the Durst printers, lives in `archive/` and still works
  (https://mikeb-art.github.io/machine-maintenance/archive/). It logs to the same Machine Maintenance Log sheet.
- `vutek-3r-maintenance-schedule.pdf` stays at the root because EquipFlow links to it.

## Restore the old app at the original address

Revert the archiving commit (`git revert <commit>`), or move `archive/index.html`,
`archive/dashboard-charts.js` and `archive/kpi-daily.js` back to the root.
The last pre-archive commit is `d597263` (Sep 30, 2026); the archiving commit is `c43eec4`.
