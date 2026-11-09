---
"@anywalletkit/extension-kit": patch
---

`Session.setAutoLockMs` no longer pushes the auto-lock deadline out. Before, it ended with `touch()`, so a wallet that applied its stored setting at every service-worker start (alarms, page loads and port reconnects all restart the worker) extended the deadline by a full period each time and never locked. Now it stores the period, re-arms the alarm at the stored deadline (a missed alarm comes back, an expired record locks), and only brings the deadline forward when the new period ends sooner. A longer period, or 0 (never), applies from the next `touch()` / `unlock()`: call `session.touch()` right after the user changed the setting. Call `touch()` for explicit user gestures only, not for passive polls or page requests.
