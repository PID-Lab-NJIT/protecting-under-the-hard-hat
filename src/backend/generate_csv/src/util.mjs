// Recursively flattens a nested object using dot-notation keys.
// Arrays are serialized to JSON strings since CSV cells hold scalar values.
export function flattenObj(obj, prefix) {
    const result = {};
    for (const key in obj) {
        const val = obj[key];
        const fullKey = prefix ? prefix + '.' + key : key;
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            Object.assign(result, flattenObj(val, fullKey));
        } else {
            result[fullKey] = Array.isArray(val) ? JSON.stringify(val) : val;
        }
    }
    return result;
}

// Escapes a value for CSV output per RFC 4180.
export function csvEscape(val) {
    if (val == null) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}