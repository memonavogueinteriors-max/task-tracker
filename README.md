# Team Task Tracker — Live Multi-Device Version

This version is designed for Vercel + Supabase and works from different locations and devices using one shared database.

## What is included

- Employee ID + PIN login
- Owner, Manager, and Sales roles
- Owner creates members and assigns managers
- Manager sees and assigns tasks to their own team
- Sales sees their own tasks
- Selected login and logout times
- Task date, status, notes, and hours
- Finish Day creates a permanent daily record
- Ring notifications
- Shared company name, logo, and colors
- Automatic Google Sheet upsert for every task
- Server-side permission enforcement

## 1. Create Supabase

1. Create a Supabase project.
2. Open **SQL Editor**.
3. Paste and run `supabase-schema.sql`.
4. Copy:
   - Project URL
   - Secret key / legacy service_role key

## 2. Deploy to Vercel

Upload this project to GitHub, then import it into Vercel.

Add these Vercel Environment Variables for Production, Preview, and Development:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET`

Generate `JWT_SECRET` in PowerShell:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | ForEach-Object {[char]$_})
```

Redeploy after adding the variables.

## 3. First login

- Employee ID: `OWNER`
- PIN: `0000`

Immediately open Owner Settings and change the Owner PIN.

## 4. Connect Google Sheets

1. Create/open a Google Sheet.
2. Open **Extensions → Apps Script**.
3. Replace the script with `google-apps-script/Code.gs`.
4. Deploy as a Web App:
   - Execute as: Me
   - Who has access: Anyone
5. Copy the `/exec` URL.
6. In the tracker: Owner → Settings → Google Sheets → paste URL → Save → Test.

Every task is now inserted or updated using its Task ID, so editing does not create duplicates. Attendance and Finish Day also refresh each task row with login time, logout time, and finished status.

## Important security note

Never put `SUPABASE_SERVICE_ROLE_KEY` in the HTML, GitHub code, or any `NEXT_PUBLIC_` variable. It belongs only in Vercel Environment Variables.
