# GitHub Deployment Guide for PRUWise

## 🚨 **IMPORTANT: Files Already Protected**

Your `.gitignore` is configured to **automatically exclude** sensitive files:
- ✅ `.env.local` (database passwords, API keys)
- ✅ `node_modules/` (dependencies)
- ✅ `.vercel/` (Vercel config)
- ✅ `php/config.php` (old config with secrets)

**You're safe to push everything else!**

---

## 📋 **Step-by-Step: Push to GitHub**

### **Step 1: Initialize Git (if not already done)**

```powershell
# Check if git is already initialized
git status
```

If you see "not a git repository", run:
```powershell
git init
```

---

### **Step 2: Create GitHub Repository**

1. Go to: https://github.com/new
2. **Repository name:** `pruwise` (or `Prudential_TheGoats`)
3. **Visibility:** Choose **Private** (recommended - keeps demo passwords safe)
4. **DON'T** initialize with README (you already have one)
5. Click **"Create repository"**

---

### **Step 3: Add All Files to Git**

```powershell
# Add all files (gitignore will automatically skip sensitive ones)
git add .

# Check what's being added (make sure .env.local is NOT in the list)
git status
```

**✅ You should see files like:**
- `index.html`
- `js/`, `css/`, `api/`
- `package.json`
- `README.md`
- etc.

**❌ You should NOT see:**
- `.env.local`
- `node_modules/`
- `.vercel/`

---

### **Step 4: Make First Commit**

```powershell
git commit -m "Initial commit: PRUWise hackathon project"
```

---

### **Step 5: Connect to GitHub**

Replace `YOUR-USERNAME` and `REPO-NAME` with your actual GitHub username and repo name:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/REPO-NAME.git
git branch -M main
git push -u origin main
```

**Example:**
```powershell
git remote add origin https://github.com/the-goat-s/pruwise.git
git branch -M main
git push -u origin main
```

---

### **Step 6: Verify on GitHub**

1. Go to your GitHub repository
2. Check that files are there
3. **Verify `.env.local` is NOT visible** (should be blocked by gitignore)

---

## 🔗 **Step 7: Connect GitHub to Vercel (Automatic Deployments)**

### **Option A: Through Vercel Dashboard (Recommended)**

1. Go to: https://vercel.com/the-goat-s/pruwise/settings/git
2. Click **"Connect Git Repository"**
3. Select **GitHub**
4. Choose your repository
5. Click **"Connect"**

**Now every `git push` will automatically deploy to Vercel!** 🚀

### **Option B: Through GitHub**

1. In your GitHub repo, go to **Settings** → **Integrations** → **Vercel**
2. Click **"Configure"**
3. Select the repository
4. Done!

---

## 📦 **What Gets Uploaded to GitHub**

### ✅ **INCLUDED (Safe to Upload):**

```
├── index.html
├── package.json
├── tsconfig.json
├── vercel.json
├── README.md
├── FEASIBILITY_SUMMARY.md
├── TECHNICAL_FEASIBILITY.md
├── QA_GUIDE.md
├── DEMO_CHEAT_SHEET.md
├── .gitignore
├── .vercelignore
├── api/
│   ├── router.ts
│   ├── _lib/
│   └── _routes/
├── js/
│   ├── app.js
│   ├── call.js
│   ├── api.js
│   └── ...
├── css/
│   ├── base.css
│   ├── components.css
│   └── ...
├── db/
│   ├── schema.sql
│   └── seed.sql
├── scripts/
│   ├── db-push.ts
│   └── *.mjs
└── assets/
```

### ❌ **EXCLUDED (Protected by .gitignore):**

```
.env.local              ← Database passwords, API keys
.env                    ← Any environment files
node_modules/           ← Dependencies (reinstalled with npm install)
.vercel/                ← Vercel local config
php/config.php          ← Old PHP secrets (if it exists)
php/uploads/*           ← User-uploaded files
php/mail-log/           ← Password reset emails
*.log                   ← Log files
```

---

## 🔒 **Security Checklist**

Before pushing, verify:

- [ ] `.env.local` is in `.gitignore` ✅ (already is)
- [ ] `node_modules/` is in `.gitignore` ✅ (already is)
- [ ] No API keys in source code ✅ (they're in .env.local)
- [ ] Database passwords not in code ✅ (they're in .env.local)
- [ ] Demo passwords in README are okay ✅ (studsarah, studkris - for demo only)

**You're already protected!** ✅

---

## 🎯 **After Pushing to GitHub**

### **Collaborating with Teammates:**

**Your teammates can now:**

1. **Clone the repository:**
   ```powershell
   git clone https://github.com/YOUR-USERNAME/pruwise.git
   cd pruwise
   ```

2. **Install dependencies:**
   ```powershell
   npm install
   ```

3. **Get environment variables:**
   - They need to create their own `.env.local`
   - OR you can run: `npx vercel env pull .env.local` (if they have Vercel access)

4. **Run locally:**
   ```powershell
   npx vercel dev
   ```

---

## 🚀 **Updating After Changes**

**Every time you make changes:**

```powershell
# 1. Check what changed
git status

# 2. Add all changes
git add .

# 3. Commit with message
git commit -m "Fixed video call issue"

# 4. Push to GitHub (triggers Vercel deployment if connected)
git push
```

**Deployment happens automatically in ~30 seconds!** ✨

---

## 🛠️ **Troubleshooting**

### **"Repository not found" error:**
- Check the URL: `git remote -v`
- Fix with: `git remote set-url origin https://github.com/YOUR-USERNAME/REPO-NAME.git`

### **"Permission denied" error:**
- You need to authenticate with GitHub
- Run: `git config --global credential.helper wincred`
- Or use GitHub Desktop: https://desktop.github.com/

### **".env.local appeared in git status":**
- **STOP!** Don't commit it
- Run: `git reset HEAD .env.local`
- Make sure `.env.local` is in `.gitignore`

### **"node_modules appearing in git":**
- **STOP!** Don't commit them
- Run: `git rm -r --cached node_modules`
- Make sure `node_modules/` is in `.gitignore`

---

## 📊 **GitHub Benefits for Your Team**

### **Version Control:**
- ✅ See all changes over time
- ✅ Revert bad changes instantly
- ✅ Never lose work

### **Collaboration:**
- ✅ Multiple people can work simultaneously
- ✅ Pull requests for code review
- ✅ Issues for bug tracking

### **Automatic Deployment:**
- ✅ Push code → Vercel deploys automatically
- ✅ Preview deployments for branches
- ✅ Rollback to previous versions

### **Backup:**
- ✅ Code is safe on GitHub servers
- ✅ Can access from anywhere
- ✅ Can clone to new computers

---

## 🎉 **Quick Command Reference**

```powershell
# First time setup
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main

# Daily workflow
git status                    # See what changed
git add .                     # Stage all changes
git commit -m "Description"   # Save changes
git push                      # Upload to GitHub (triggers deploy)

# Getting teammate's changes
git pull                      # Download latest changes

# Checking remote
git remote -v                 # Show GitHub URL

# Seeing history
git log                       # View commit history
```

---

## ✅ **You're Ready!**

Your project is configured correctly. Just follow Step 1-6 above and you'll have:
- ✅ Code backed up on GitHub
- ✅ Secrets protected (not uploaded)
- ✅ Team can collaborate
- ✅ Automatic deployments to Vercel

**Good luck with your hackathon! 🚀**

---

**Created:** September 2, 2026  
**Project:** PRUWise - AI Insurance Navigator  
**Team:** The Goats
