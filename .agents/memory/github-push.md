---
name: GitHub push method
description: How to push file changes to the choice121/Choice repo via GitHub API without git CLI.
---

## Rule
Create blobs → create tree (base_tree = HEAD tree SHA) → create commit (parents = [HEAD SHA]) → PATCH refs/heads/main.

**Why:** Replit environment has no git push access; the GitHub Contents API is too slow for multi-file commits. The Git Data API is the correct path.

**How to apply:**
1. `GET /repos/{owner}/{repo}/git/refs/heads/main` → `object.sha` = HEAD SHA
2. `GET /repos/{owner}/{repo}/git/commits/{HEAD SHA}` → `tree.sha` = base tree SHA
3. `POST /repos/{owner}/{repo}/git/blobs` for each file (encoding: utf-8) — capture full SHA from response
4. `POST /repos/{owner}/{repo}/git/trees` with `{ base_tree: baseTreeSha, tree: [{path, mode:'100644', type:'blob', sha}] }`
5. `POST /repos/{owner}/{repo}/git/commits` with `{ message, tree: treeSha, parents: [headSha] }`
6. `PATCH /repos/{owner}/{repo}/git/refs/heads/main` with `{ sha: commitSha }`
