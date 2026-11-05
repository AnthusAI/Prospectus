#!/usr/bin/env bash
# Writes the private quota rate table to its SSM SecureString parameter. A person runs this from private configuration
# outside the repository; the values never enter Git and are never printed.
#
#   AWS_PROFILE=<profile> scripts/write-quota-rate-table.sh --account <12-digit id> --values <file>
set -euo pipefail

parameter=/prospectus/central-accounts/quota-rate-table/v1
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
refuse() {
  echo "write-quota-rate-table: $1" >&2
  exit 2
}

account=""
values=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --account) [ "$#" -ge 2 ] || refuse "--account needs a value"; account="$2"; shift 2 ;;
    --values) [ "$#" -ge 2 ] || refuse "--values needs a value"; values="$2"; shift 2 ;;
    *) refuse "usage: AWS_PROFILE=<profile> $0 --account <12-digit id> --values <file>" ;;
  esac
done
[[ "${account}" =~ ^[0-9]{12}$ ]] || refuse "--account must be a 12-digit account id"
[ -n "${values}" ] && [ -f "${values}" ] || refuse "--values must name an existing file"

if grep -q '<' "${values}"; then
  refuse "the values file still contains < placeholders"
fi
if ! node --import tsx "${root}/scripts/validate-quota-rate-table.ts" "${values}"; then
  refuse "the values file failed the rate table check"
fi

signed_in="$(aws sts get-caller-identity --query Account --output text)" || refuse "could not read the signed-in account"
[ "${signed_in}" = "${account}" ] || refuse "the signed-in account does not match --account"

version="$(aws ssm put-parameter --name "${parameter}" --type SecureString --tier Advanced --overwrite \
  --value "file://${values}" --query Version --output text)"
echo "${version}"
