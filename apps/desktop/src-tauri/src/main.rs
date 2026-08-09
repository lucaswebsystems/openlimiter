// Prevents a console window from opening beside the application on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    openlimiter_desktop_lib::run()
}
