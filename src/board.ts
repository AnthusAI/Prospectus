/** The board this CRM serves in the multi-board Kanbus API: `/{tenant}/{project}` (Kanbus#502). */
export const KANBUS_TENANT = "cyclotron";
export const KANBUS_PROJECT = "prospectus";
export const KANBUS_BOARD_PATH = `/${KANBUS_TENANT}/${KANBUS_PROJECT}`;
export const KANBUS_API_PATH = `${KANBUS_BOARD_PATH}/api`;
export const KANBUS_BOARD_GROUP = `kanbus:${KANBUS_TENANT}/${KANBUS_PROJECT}`;
