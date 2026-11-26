#!/usr/bin/env bash
#
# Create the GitHub repository and push everything.
#
#   GITHUB_USER=username bash scripts/push-to-github.sh
#   VISIBILITY=private  bash scripts/push-to-github.sh
#
set -euo pipefail

REPO_NAME="${REPO_NAME:-train-count}"
VISIBILITY="${VISIBILITY:-public}"
USER_HANDLE="${GITHUB_USER:-USERNAME}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

cd "$(dirname "$0")/.."

echo "▸ repo: $REPO_NAME | branch: $BRANCH | visibility: $VISIBILITY"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if gh repo view "$REPO_NAME" >/dev/null 2>&1; then
    echo "▸ repository exists — pushing…"
    git remote get-url origin >/dev/null 2>&1 || \
      git remote add origin "$(gh repo view "$REPO_NAME" --json sshUrl -q .sshUrl)"
    git push -u origin "$BRANCH"
  else
    gh repo create "$REPO_NAME" --"$VISIBILITY" --source=. --remote=origin --push \
      --description "Dependency-free class attendance tracker with a Persian (Jalali) calendar"
  fi
  echo "✓ done: $(gh repo view "$REPO_NAME" --json url -q .url)"
  exit 0
fi

echo
echo "⚠️  GitHub CLI (gh) not found or not logged in. Choose one:"
echo
echo "  1) install gh, then:  gh auth login && bash scripts/push-to-github.sh"
echo "  2) create an empty repo at https://github.com/new named \"$REPO_NAME\", then:"
echo "       git remote add origin https://github.com/$USER_HANDLE/$REPO_NAME.git"
echo "       git push -u origin $BRANCH"
echo "  3) or with a token:"
echo "       git remote add origin https://<TOKEN>@github.com/$USER_HANDLE/$REPO_NAME.git"
echo "       git push -u origin $BRANCH"
echo
