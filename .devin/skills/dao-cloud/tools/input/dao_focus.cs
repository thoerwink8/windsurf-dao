using System;
using System.Runtime.InteropServices;
// dao_focus：把指定 PID 的主窗口抬到前台（可选最大化/还原），绕过 Windows 前台锁。
// 用法：dao_focus.exe <pid> [showCmd]
//   showCmd: 9=SW_RESTORE(默认)  3=SW_MAXIMIZE  6=SW_MINIMIZE
// 注意：若用户正在主动输入/点击，Windows 前台锁会让 SetForegroundWindow 失效——
// 这属于正常现象，按 dao-cloud SKILL.md「实时桌面交互礼仪」停 ~10 秒再重试。
class F {
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  static void Main(string[] a) {
    int pid = int.Parse(a[0]);
    int show = a.Length > 1 ? int.Parse(a[1]) : 9;
    IntPtr h = System.Diagnostics.Process.GetProcessById(pid).MainWindowHandle;
    if (h == IntPtr.Zero) { Console.WriteLine("NO_HWND"); return; }
    ShowWindowAsync(h, show);
    SetForegroundWindow(h);
    Console.WriteLine("FOCUS " + pid + " show=" + show);
  }
}
