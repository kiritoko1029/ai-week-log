// 桌面端二进制入口。真正的初始化逻辑在 lib::run()。
// 这种 main/lib 拆分是 Tauri 2 官方脚手架的约定，便于未来复用到移动端。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    weeklog_lib::run()
}
