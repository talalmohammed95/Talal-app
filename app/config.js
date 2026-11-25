// Connects the app to your Supabase project (Supabase › Project Settings › API).
// The anon key is designed to be public; the database's access rules protect the data.
// Leave both empty to run the app on this device only, with a PIN.
window.ORLA_CONFIG = window.ORLA_CONFIG || {
  supabaseUrl: "",
  supabaseAnonKey: ""
};
