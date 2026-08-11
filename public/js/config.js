// App configuration: model/voice selection, pointer-aware copy, and the form's
// field definitions — the single source of truth the prompt, the UI, and the
// validators all derive from.

export const MODEL = "gemini-3.1-flash-live-preview";
export const VOICE = "Aoede";

// "Tap" on touch devices, "Click" on a mouse/desktop pointer — used in all
// user-facing prompts so the verb matches how the person actually interacts.
export const POINTER_COARSE = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
export const TAP = POINTER_COARSE ? "Tap" : "Click";
export const tap = POINTER_COARSE ? "tap" : "click";

export const NYC_BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];

export const FIELDS = [
  // `ac` = HTML autocomplete token (WCAG 1.3.5 Identify Input Purpose). App-specific
  // fields intentionally opt out of autofill with "off".
  { key: "first_name",    label: "First name", q: "What's your first name?",            hint: "Spell if necessary.", ac: "given-name" },
  { key: "last_name",     label: "Last name",  q: "And your last name?",                hint: "Spell if necessary.", ac: "family-name" },
  { key: "address",       label: "Address (New York City)", q: "What's your home address in New York City?", hint: "Must be in NYC, and specify the borough.", ac: "street-address" },
  { key: "date_of_birth", label: "Date of birth", q: "What's your date of birth?",      hint: "Month, day and year.", ac: "bday" },
  { key: "phone",         label: "Phone number", q: "What's your phone number?",         hint: "10 digits, or include a country code.", tel: true, ac: "tel" },
  { key: "household_size", label: "Household size", q: "How many people are in your household?", hint: "Everyone who lives and eats together — 1 to 8 or more.", select: ["1", "2", "3", "4", "5", "6", "7", "8 or more"], ph: "Select number of people…", ac: "off" },
  { key: "household_income", label: "Monthly household income", q: "About how much does your household earn each month, before taxes?", hint: "A dollar amount — say zero if there's no income.", ac: "off" },
  { key: "preferred_language", label: "Preferred language", q: "What language would you like to get notices in?", hint: "", select: ["English", "Spanish", "Chinese", "Bengali", "Russian", "Haitian Creole", "Korean", "Arabic", "Yiddish", "Other"], ph: "Select a language…", ac: "off" },
];
