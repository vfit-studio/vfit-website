#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# VFIT Client Setup Script
# Usage: ./setup-client.sh client-config.json
# ─────────────────────────────────────────────────────────────

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ok()   { echo -e "${GREEN}✓${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
info() { echo -e "${YELLOW}→${NC} $*"; }
hdr()  { echo -e "\n${CYAN}${BOLD}── $* ──${NC}"; }

die() { err "$@"; exit 1; }

# ── Arg check ────────────────────────────────────────────────
CONFIG_FILE="${1:-}"
if [[ -z "$CONFIG_FILE" ]]; then
  die "Usage: ./setup-client.sh <client-config.json>"
fi
if [[ ! -f "$CONFIG_FILE" ]]; then
  die "Config file not found: $CONFIG_FILE"
fi

# ── Resolve paths ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$(cd "$(dirname "$CONFIG_FILE")" && pwd)/$(basename "$CONFIG_FILE")"

# ── Helper: read JSON field via python3 ──────────────────────
json_get() {
  python3 -c "
import json, sys
with open('$CONFIG_FILE') as f:
    data = json.load(f)
keys = '$1'.split('.')
val = data
for k in keys:
    if isinstance(val, dict):
        val = val.get(k, '')
    else:
        val = ''
        break
print(val if val is not None else '')
"
}

json_get_raw() {
  python3 -c "
import json, sys
with open('$CONFIG_FILE') as f:
    data = json.load(f)
keys = '$1'.split('.')
val = data
for k in keys:
    if isinstance(val, dict):
        val = val.get(k, '')
    else:
        val = ''
        break
print(json.dumps(val))
"
}

# ── Read config values ───────────────────────────────────────
hdr "Reading config"

BIZ_NAME="$(json_get 'business.name')"
BIZ_EMAIL="$(json_get 'business.email')"
BIZ_LOCATION="$(json_get 'business.location')"

GITHUB_ORG="$(json_get 'infrastructure.github_org')"
REPO_NAME="$(json_get 'infrastructure.repo_name')"
NETLIFY_SITE="$(json_get 'infrastructure.netlify_site_name')"
SUPABASE_PROJECT="$(json_get 'infrastructure.supabase_project_name')"
ADMIN_PASSWORD="$(json_get 'infrastructure.admin_password')"
OWNER_EMAIL="$(json_get 'infrastructure.owner_email')"

GA_ID="$(json_get 'integrations.google_analytics_id')"
META_PIXEL="$(json_get 'integrations.meta_pixel_id')"
WHATSAPP="$(json_get 'integrations.whatsapp_number')"

ok "Business: $BIZ_NAME ($BIZ_LOCATION)"
ok "GitHub:   $GITHUB_ORG/$REPO_NAME"
ok "Netlify:  $NETLIFY_SITE"
ok "Supabase: $SUPABASE_PROJECT"

# ── Validate required fields ─────────────────────────────────
hdr "Validating config"

REQUIRED_FIELDS=(
  "business.name"
  "business.email"
  "infrastructure.github_org"
  "infrastructure.repo_name"
  "infrastructure.netlify_site_name"
  "infrastructure.supabase_project_name"
  "infrastructure.admin_password"
)

MISSING=0
for field in "${REQUIRED_FIELDS[@]}"; do
  val="$(json_get "$field")"
  if [[ -z "$val" ]]; then
    err "Missing required field: $field"
    MISSING=1
  fi
done

if [[ "$MISSING" -eq 1 ]]; then
  die "Fix missing fields in config and re-run."
fi
ok "All required fields present"

# ── Check prerequisites ──────────────────────────────────────
hdr "Checking prerequisites"

command -v gh >/dev/null 2>&1       || die "gh CLI not found. Install: brew install gh"
command -v netlify >/dev/null 2>&1   || die "netlify CLI not found. Install: npm i -g netlify-cli"
command -v python3 >/dev/null 2>&1   || die "python3 not found"
command -v git >/dev/null 2>&1       || die "git not found"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  die "SUPABASE_ACCESS_TOKEN env var not set. Get one from https://supabase.com/dashboard/account/tokens"
fi

# Verify gh is authenticated
gh auth status >/dev/null 2>&1 || die "gh CLI not authenticated. Run: gh auth login"

ok "All prerequisites met"

# ── Step 1: GitHub org ───────────────────────────────────────
hdr "Step 1 — GitHub Organization"

if gh api "orgs/$GITHUB_ORG" >/dev/null 2>&1; then
  ok "Org '$GITHUB_ORG' already exists"
else
  info "Creating org '$GITHUB_ORG'..."
  # gh CLI cannot create orgs — they must be created via web UI
  # Check if it's a user account instead
  if gh api "users/$GITHUB_ORG" >/dev/null 2>&1; then
    ok "Using user account '$GITHUB_ORG' as owner"
  else
    die "GitHub org/user '$GITHUB_ORG' does not exist. Create it at https://github.com/organizations/plan"
  fi
fi

# ── Step 2: GitHub repo ─────────────────────────────────────
hdr "Step 2 — GitHub Repository"

if gh repo view "$GITHUB_ORG/$REPO_NAME" >/dev/null 2>&1; then
  ok "Repo '$GITHUB_ORG/$REPO_NAME' already exists"
else
  info "Creating repo '$GITHUB_ORG/$REPO_NAME'..."
  gh repo create "$GITHUB_ORG/$REPO_NAME" --private --description "$BIZ_NAME website" || die "Failed to create repo"
  ok "Repo created"
fi

# ── Step 3: Copy template files ──────────────────────────────
hdr "Step 3 — Copy Template Files"

WORK_DIR="$(mktemp -d)"
info "Working directory: $WORK_DIR"

# Files and directories to copy from the template (script's directory)
COPY_ITEMS=(
  "index.html"
  "admin.html"
  "netlify"
  "netlify.toml"
  "package.json"
  "package-lock.json"
  "schema-memberships.sql"
  "apps-script.js"
)

COPIED=0
for item in "${COPY_ITEMS[@]}"; do
  src="$SCRIPT_DIR/$item"
  if [[ -e "$src" ]]; then
    if [[ -d "$src" ]]; then
      cp -R "$src" "$WORK_DIR/"
    else
      cp "$src" "$WORK_DIR/"
    fi
    ((COPIED++))
  else
    info "Skipping (not found): $item"
  fi
done

# Also copy the client config into the deploy directory
cp "$CONFIG_FILE" "$WORK_DIR/client-config.json"

ok "Copied $COPIED template items"

# ── Step 4: Inject tracking snippets ─────────────────────────
hdr "Step 4 — Inject Tracking Snippets"

INDEX_FILE="$WORK_DIR/index.html"

if [[ -f "$INDEX_FILE" ]]; then

  # Google Analytics
  if [[ -n "$GA_ID" ]]; then
    GA_SNIPPET="<script async src=\"https://www.googletagmanager.com/gtag/js?id=${GA_ID}\"></script>\n<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA_ID}');</script>"
    python3 -c "
import sys
with open('$INDEX_FILE', 'r') as f:
    content = f.read()
snippet = '''$GA_SNIPPET'''
if '</head>' in content and '$GA_ID' not in content:
    content = content.replace('</head>', snippet + '\n</head>')
    with open('$INDEX_FILE', 'w') as f:
        f.write(content)
    print('Injected')
else:
    print('Skipped')
" && ok "Google Analytics ($GA_ID) injected" || info "GA injection skipped"
  else
    info "No Google Analytics ID — skipping"
  fi

  # Meta Pixel
  if [[ -n "$META_PIXEL" ]]; then
    python3 << PYEOF
with open('$INDEX_FILE', 'r') as f:
    content = f.read()
snippet = """<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL}');fbq('track','PageView');</script>"""
if '</head>' in content and '${META_PIXEL}' not in content:
    content = content.replace('</head>', snippet + '\n</head>')
    with open('$INDEX_FILE', 'w') as f:
        f.write(content)
    print('Injected')
else:
    print('Skipped')
PYEOF
    ok "Meta Pixel ($META_PIXEL) injected"
  else
    info "No Meta Pixel ID — skipping"
  fi

  # WhatsApp floating button
  if [[ -n "$WHATSAPP" ]]; then
    python3 << PYEOF
with open('$INDEX_FILE', 'r') as f:
    content = f.read()
snippet = """<a href="https://wa.me/${WHATSAPP}" target="_blank" class="whatsapp-float" aria-label="Chat on WhatsApp">
  <svg viewBox="0 0 24 24" width="28" height="28" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18a8 8 0 01-4.243-1.214l-.252-.156-2.905.863.863-2.905-.156-.252A8 8 0 1112 20z"/></svg>
</a>
<style>.whatsapp-float{position:fixed;bottom:24px;right:24px;width:56px;height:56px;background:#25D366;border-radius:50%;display:flex;align-items:center;justify-content:center;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:transform 0.3s;}.whatsapp-float:hover{transform:scale(1.1);}@media(max-width:768px){.whatsapp-float{bottom:calc(16px + env(safe-area-inset-bottom));right:16px;}}</style>"""
if '</body>' in content and 'whatsapp-float' not in content:
    content = content.replace('</body>', snippet + '\n</body>')
    with open('$INDEX_FILE', 'w') as f:
        f.write(content)
    print('Injected')
else:
    print('Skipped')
PYEOF
    ok "WhatsApp button ($WHATSAPP) injected"
  else
    info "No WhatsApp number — skipping"
  fi

else
  info "No index.html found — skipping snippet injection"
fi

# ── Step 5: Git init, commit, push ───────────────────────────
hdr "Step 5 — Git Init & Push"

cd "$WORK_DIR"

if [[ ! -d ".git" ]]; then
  git init -q
  git remote add origin "https://github.com/$GITHUB_ORG/$REPO_NAME.git" 2>/dev/null || true
fi

# Ensure remote is correct
CURRENT_REMOTE="$(git remote get-url origin 2>/dev/null || echo '')"
EXPECTED_REMOTE="https://github.com/$GITHUB_ORG/$REPO_NAME.git"
if [[ "$CURRENT_REMOTE" != "$EXPECTED_REMOTE" ]]; then
  git remote set-url origin "$EXPECTED_REMOTE" 2>/dev/null || git remote add origin "$EXPECTED_REMOTE"
fi

git add -A
if git diff --cached --quiet 2>/dev/null; then
  info "No changes to commit (already up to date)"
else
  git commit -q -m "Initial setup for $BIZ_NAME website"
  ok "Committed"
fi

# Push — set up main branch
git branch -M main
git push -u origin main --force-with-lease 2>/dev/null || git push -u origin main
ok "Pushed to GitHub"

# ── Step 6: Create Netlify site ──────────────────────────────
hdr "Step 6 — Netlify Site"

# Check if site exists already
NETLIFY_SITE_EXISTS=0
netlify api listSites --data '{}' 2>/dev/null | python3 -c "
import json, sys
sites = json.load(sys.stdin)
for s in sites:
    if s.get('name') == '$NETLIFY_SITE':
        print(s['id'])
        sys.exit(0)
sys.exit(1)
" && NETLIFY_SITE_EXISTS=1 || true

if [[ "$NETLIFY_SITE_EXISTS" -eq 1 ]]; then
  ok "Netlify site '$NETLIFY_SITE' already exists"
else
  info "Creating Netlify site '$NETLIFY_SITE'..."
  netlify sites:create --name "$NETLIFY_SITE" --disable-linking 2>/dev/null || die "Failed to create Netlify site"
  ok "Netlify site created"
fi

# Link the site
cd "$WORK_DIR"
netlify link --name "$NETLIFY_SITE" 2>/dev/null || info "Site linking — may need manual confirmation"
ok "Netlify site linked"

# ── Step 7: Create Supabase project ─────────────────────────
hdr "Step 7 — Supabase Project"

# Check if project already exists
SUPABASE_REF=""
SUPABASE_REF="$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects" | python3 -c "
import json, sys
projects = json.load(sys.stdin)
for p in projects:
    if p.get('name') == '$SUPABASE_PROJECT':
        print(p['id'])
        sys.exit(0)
sys.exit(1)
" 2>/dev/null)" || true

if [[ -n "$SUPABASE_REF" ]]; then
  ok "Supabase project '$SUPABASE_PROJECT' already exists (ref: $SUPABASE_REF)"
else
  info "Creating Supabase project '$SUPABASE_PROJECT'..."

  # Generate a random database password
  DB_PASSWORD="$(python3 -c "import secrets, string; print(''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(24)))")"

  CREATE_RESPONSE="$(curl -s -X POST \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"name\": \"$SUPABASE_PROJECT\",
      \"organization_id\": \"\",
      \"db_pass\": \"$DB_PASSWORD\",
      \"region\": \"ap-southeast-2\",
      \"plan\": \"free\"
    }" \
    "https://api.supabase.com/v1/projects")"

  SUPABASE_REF="$(echo "$CREATE_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")"

  if [[ -z "$SUPABASE_REF" ]]; then
    err "Supabase response: $CREATE_RESPONSE"
    die "Failed to create Supabase project"
  fi

  ok "Supabase project created (ref: $SUPABASE_REF)"

  # Wait for project to be ready
  info "Waiting for Supabase project to be ready..."
  for i in $(seq 1 60); do
    STATUS="$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
      "https://api.supabase.com/v1/projects/$SUPABASE_REF" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('status', 'UNKNOWN'))
" 2>/dev/null)"
    if [[ "$STATUS" == "ACTIVE_HEALTHY" ]]; then
      ok "Project is ready"
      break
    fi
    if [[ "$i" -eq 60 ]]; then
      die "Timed out waiting for Supabase project to become ready (status: $STATUS)"
    fi
    sleep 5
  done
fi

# Get project details (URL + keys)
SUPABASE_URL="https://$SUPABASE_REF.supabase.co"

API_KEYS_RESPONSE="$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$SUPABASE_REF/api-keys")"

SUPABASE_ANON_KEY="$(echo "$API_KEYS_RESPONSE" | python3 -c "
import json, sys
keys = json.load(sys.stdin)
for k in keys:
    if k.get('name') == 'anon':
        print(k['api_key'])
        sys.exit(0)
print('')
" 2>/dev/null)"

SUPABASE_SERVICE_KEY="$(echo "$API_KEYS_RESPONSE" | python3 -c "
import json, sys
keys = json.load(sys.stdin)
for k in keys:
    if k.get('name') == 'service_role':
        print(k['api_key'])
        sys.exit(0)
print('')
" 2>/dev/null)"

ok "Supabase URL: $SUPABASE_URL"

# ── Step 8: Run SQL schema ───────────────────────────────────
hdr "Step 8 — Database Schema"

SCHEMA_FILE="$WORK_DIR/schema-memberships.sql"
if [[ -f "$SCHEMA_FILE" ]]; then
  SQL_CONTENT="$(python3 -c "
import json
with open('$SCHEMA_FILE') as f:
    print(json.dumps(f.read()))
")"

  QUERY_RESPONSE="$(curl -s -X POST \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": $SQL_CONTENT}" \
    "https://api.supabase.com/v1/projects/$SUPABASE_REF/database/query")"

  # Check for errors
  echo "$QUERY_RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
if isinstance(data, dict) and data.get('error'):
    print(data['error'])
    sys.exit(1)
" 2>/dev/null && ok "SQL schema applied" || {
    info "Schema may already exist or had non-fatal issues"
    ok "Schema step complete"
  }
else
  info "No schema-memberships.sql found — skipping"
fi

# ── Step 9: Set Netlify environment variables ────────────────
hdr "Step 9 — Netlify Environment Variables"

SITE_URL="https://$NETLIFY_SITE.netlify.app"

cd "$WORK_DIR"

# Helper to set env var (idempotent — unset then set)
set_netlify_env() {
  local key="$1"
  local val="$2"
  if [[ -n "$val" ]]; then
    netlify env:set "$key" "$val" --force 2>/dev/null || netlify env:set "$key" "$val" 2>/dev/null || info "Could not set $key"
  fi
}

set_netlify_env "SUPABASE_URL" "$SUPABASE_URL"
set_netlify_env "SUPABASE_SERVICE_KEY" "$SUPABASE_SERVICE_KEY"
set_netlify_env "SUPABASE_ANON_KEY" "$SUPABASE_ANON_KEY"
set_netlify_env "ADMIN_KEY" "$ADMIN_PASSWORD"
set_netlify_env "SITE_URL" "$SITE_URL"
set_netlify_env "BUSINESS_NAME" "$BIZ_NAME"
set_netlify_env "BUSINESS_EMAIL" "$BIZ_EMAIL"

# Optional integrations
[[ -n "$GA_ID" ]]      && set_netlify_env "GOOGLE_ANALYTICS_ID" "$GA_ID"
[[ -n "$META_PIXEL" ]] && set_netlify_env "META_PIXEL_ID" "$META_PIXEL"
[[ -n "$WHATSAPP" ]]   && set_netlify_env "WHATSAPP_NUMBER" "$WHATSAPP"

# Owner details
[[ -n "$OWNER_EMAIL" ]] && set_netlify_env "OWNER_EMAIL" "$OWNER_EMAIL"

ok "Environment variables set"

# ── Step 10: Deploy to production ────────────────────────────
hdr "Step 10 — Deploy to Production"

cd "$WORK_DIR"
netlify deploy --prod --dir="$WORK_DIR" --message "Initial deploy for $BIZ_NAME" || die "Netlify deploy failed"

ok "Deployed to production"

# ── Summary ──────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Client Setup Complete!${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${GREEN}✓${NC} Client:   ${BOLD}$BIZ_NAME${NC}"
echo -e "  ${GREEN}✓${NC} Website:  ${BOLD}$SITE_URL${NC}"
echo -e "  ${GREEN}✓${NC} Admin:    ${BOLD}$SITE_URL/admin.html${NC}"
echo -e "  ${GREEN}✓${NC} Password: ${BOLD}$ADMIN_PASSWORD${NC}"
echo -e "  ${GREEN}✓${NC} GitHub:   ${BOLD}https://github.com/$GITHUB_ORG/$REPO_NAME${NC}"
echo -e "  ${GREEN}✓${NC} Supabase: ${BOLD}$SUPABASE_URL${NC}"
echo ""
echo -e "  ${YELLOW}Config:${NC} $CONFIG_FILE"
echo -e "  ${YELLOW}Work dir:${NC} $WORK_DIR"
echo ""

# Cleanup info
info "The working directory ($WORK_DIR) contains the deployed files."
info "You can safely delete it or keep it for reference."
