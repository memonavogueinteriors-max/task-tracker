# Team Task Tracker 2.0

Live Vercel + Supabase task tracker with:

- Morning Huddle 1-3-5 format: 1 High, 3 Medium, 5 Low tasks per employee/day
- Hours and minutes dropdowns
- Owner, Sales Team, Operational Manager, and Developer departments
- Supabase multi-device storage
- Google Sheets sync
- Email task notifications through Google Apps Script MailApp
- One-click logout
- Protected background refresh that does not erase typing

## Email rules

- Owner assigns to a member: assigned member receives email.
- Operational Manager assigns to a member: member and Owner receive email.
- Sales Team or Developer creates a task: Owner receives email.

## Upgrade order

1. Run `supabase-migration-1-3-5.sql` in Supabase.
2. Replace the deployed project files.
3. Add `APPS_SCRIPT_SHARED_SECRET` in Vercel.
4. Replace and redeploy `google-apps-script/Code.gs`.
5. Add the same secret in Apps Script Project Settings → Script Properties.
6. Save Owner email and Apps Script URL in Owner Settings.
7. Test the connector and test email.

See `UPGRADE-STEPS.txt` for exact steps.
