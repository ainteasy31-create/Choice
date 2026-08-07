import os
import sys
import subprocess

cmd = [sys.executable, 'scraper/douglasville_ga_batch.py', '--dry-run', '--target', '3', '--past-days', '90']
print('RUN', ' '.join(cmd))
proc = subprocess.run(cmd, cwd='c:/Users/HP/Choice', capture_output=True, text=True)
print(proc.stdout)
print(proc.stderr)
print('RC', proc.returncode)
