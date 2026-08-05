Update Pets helper

Files:
- scripts/update_pets.js — Node script that performs a dry-run or applies updates via Supabase REST.
- scripts/run_update_pets.ps1 — PowerShell helper that prompts for credentials securely and runs the script.

Quick steps (PowerShell):

1. Open PowerShell in the repo root.
2. Run the helper:

```powershell
.\scripts\run_update_pets.ps1
```

3. When prompted, provide your `SUPABASE_URL` and the `service_role` key. Choose dry-run first.
4. Review the CSV report under `artifacts/update-pets-report-*.csv`.
5. To apply changes, re-run the helper and answer NO to dry-run and confirm by typing `YES`.

Notes:
- Do NOT paste secrets in chat. Enter them in the PowerShell prompt.
- The helper avoids echoing the service key. It sets environment variables only for the session and clears them afterwards.
- Take a DB backup or snapshot before applying changes.
