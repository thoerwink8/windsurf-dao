using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;
// dao_keys：向指定 PID 的窗口发送键盘按键（SendKeys 语法），用于 GUI 自动化里需要
// 键盘动作的场景（如打开终端、命令面板、回车确认）——补齐 dao_click 只能点鼠标的空缺。
// 用法：dao_keys.exe <pid> "<sendkeys>"
//   修饰键：^=Ctrl  +=Shift  %=Alt  ~=Enter；反引号 ` 与普通字母为字面量。
//   例：dao_keys.exe <pid> "^+`"  → Ctrl+Shift+`（新建终端）；dao_keys.exe <pid> "~" → 回车
// 会先把该 PID 的主窗口抬到前台再发键。需要更强的“绕过前台锁”时，先跑 dao_focus.exe <pid> 3。
class K {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  static void Main(string[] a) {
    if (a.Length < 2) { Console.WriteLine("usage: dao_keys.exe <pid> <sendkeys>"); return; }
    int pid = int.Parse(a[0]);
    IntPtr h = Process.GetProcessById(pid).MainWindowHandle;
    if (h == IntPtr.Zero) { Console.WriteLine("NO_HWND"); return; }
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(400);
    SendKeys.SendWait(a[1]);
    Console.WriteLine("KEYS " + pid + " " + a[1]);
  }
}
