// 1. Discard unwanted columns from CSV
export const DISCARD_KEYS = [
    "s3_timestamp",
    "uploaded_to_drive",
    "generated_as_csv",
    "data.surveyTitle",
    "data.surveyVersion",
    "data.site",
    "drive_timestamp",
    "data.test.status",
    "data.test.type",
    "data.test",
    "data.testType",
    "valid",
    "isTest",
    "isBranching",
];

// 2. Rename columns when flattening. Otherwise, only keep the deepest keys.
const RENAME_KEYS = {
    "clientInfo.ip": "ip_addr",
    "clientInfo.timezone": "ip_timezone",
    "clientInfo.lat": "ip_lat",
    "clientInfo.lon": "ip_lon",
    "clientInfo.city": "ip_city",
    "clientInfo.region": "ip_region",
    "clientInfo.country": "ip_country",
    "data.gps.supported": "gps_supported",
    "data.gps.status": "gps_status",
    "data.gps.capturedAt": "gps_timestamp",
    "data.gps.coords.latitude": "gps_lat",
    "data.gps.coords.longitude": "gps_lon",
    "data.gps.coords.accuracy": "gps_accuracy",
    "data.gps.error.code": "gps_err_code",
    "data.gps.error.message": "gps_err_msg",
    "data.deviceID": "device_id",
    "data.metadata.userAgent": "user_agent",
    "data.metadata.screenResolution": "screen_resolution",
    "data.metadata.viewportSize": "viewport_size",
    "data.metadata.timezone": "metadata_timezone",
    "data.metadata.timezoneOffset": "metadata_timezone_offset",
    "data.metadata.language": "metadata_lang",
    "data.query.branching": "query_branching",
    "data.query.test": "query_test",
    "data.isBranching": "is_branching",
    "data.isTest": "is_test",
    "data.language": "lang",
    "data.clickedResources": "clicked_resources",
    // merge keys
    "data.sessionId": "session_id",
    "data.sessionID": "session_id",
};

// add questions
// k10_1, ..., k10_10 -> 01_k10_1, ..., 10_k10_10; add k10_i keys too for merging
for (let i = 1; i <= 10; i++) {
    const padded = `${i}`.padStart(2, "0") + `_k10_${i}`;
    RENAME_KEYS[`data.answers.k10_${i}`] = padded;
    RENAME_KEYS[`data.answers.` + padded] = padded;
}

// t1, ..., t6 -> 11_t1, ..., 16_t6; add ti keys too for merging
for (let i = 11; i <= 16; i++) {
    const padded = `${i}`.padStart(2, "0") + `_t${i - 10}`;
    RENAME_KEYS[`data.answers.t${i - 10}`] = padded;
    RENAME_KEYS[`data.answers.` + padded] = padded;
}

// g0, ..., g4 -> 28_g0, ..., 32_g4; add gi keys too for merging
for (let i = 28; i <= 32; i++) {
    const padded = `${i}`.padStart(2, "0") + `_g${i - 28}`;
    RENAME_KEYS[`data.answers.g${i - 28}`] = padded;
    RENAME_KEYS[`data.answers.` + padded] = padded;
}

// non-sequential question keys
Object.assign(RENAME_KEYS, {
    "data.answers.notes1": "17_notes1",
    "data.answers.17_notes1": "17_notes1",
    "data.answers.t7": "18_t7",
    "data.answers.t8": "19_t8",
    "data.answers.t9": "20_t9",
    "data.answers.t10": "23_t10",
    "data.answers.t11": "24_t11",
    "data.answers.18_t7": "18_t7",
    "data.answers.19_t8": "19_t8",
    "data.answers.20_t9": "20_t9",
    "data.answers.23_t10": "23_t10",
    "data.answers.24_t11": "24_t11",
    "data.answers.notes2": "21_notes2",
    "data.answers.21_notes2": "21_notes2",
    "data.answers.alcohol_reasons": "22_alcohol_reasons",
    "data.answers.22_alcohol_reasons": "22_alcohol_reasons",
    "data.answers.jama1": "25_jama1",
    "data.answers.25_jama1": "25_jama1",
    "data.answers.notes_q4": "26_notes_q4",
    "data.answers.26_notes_q4": "26_notes_q4",
    "data.answers.notes_q4_followup": "27_notes_q4_followup",
    "data.answers.27_notes_q4_followup": "27_notes_q4_followup",
});

export { RENAME_KEYS };

// 3. Order columns. _start columns will be right after their non-start counterparts. Those not listed here are mostly the survey answers themselves, which are at the end.
export const ORDERED_KEYS = [
    "id",
    "device_id",
    "session_id",
    "ip_addr",
    "ip_lat",
    "ip_lon",
    "ip_city",
    "ip_region",
    "ip_country",
    "ip_timezone",
    "gps_timestamp",
    "gps_supported",
    "gps_status",
    "gps_lat",
    "gps_lon",
    "gps_accuracy",
    "gps_err_code",
    "gps_err_msg",
    "user_agent",
    "platform",
    "screen_resolution",
    "viewport_size",
    "metadata_timezone",
    "metadata_timezone_offset",
    "metadata_lang",
    "query_test",
    "query_branching",
    "is_test",
    "is_branching",
    "timestamp",
    "mode",
    "completed",
    "num_incomplete",
    "site",
    "site_id",
    "lang",
    "clicked_resources",
];

// 4. Merge with completed = false entries with _start columns.
export const START_KEYS = [
    "timestamp",
    "ip_addr",
    "ip_city",
    "ip_region",
    "ip_country",
    "ip_lat",
    "ip_lon",
    "ip_timezone",
];
