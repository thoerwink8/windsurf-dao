using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
// dao_focus：把指定 PID 的主窗口可靠抬到前台（绕过 Windows 前台锁）。
// 用 AttachThreadInput 把本线程挂到当前前台线程，再 SetForegroundWindow + 短暂 TOPMOST 翻转强制 z-order。
// 用法：dao_focus.exe <pid> [showCmd]   showCmd: 9=SW_RESTORE(默认) 3=SW_MAXIMIZE 6=SW_MINIMIZE
// 输出末尾带 ok=True/False（GetForegroundWindow()==h 实测），调用方据此判断是否需要按礼仪规则停 ~10 秒后自己重试。
class F {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1), HWND_NOTOPMOST = new IntPtr(-2);
  const uint SWP_NOMOVE = 0x2, SWP_NOSIZE = 0x1, SWP_SHOWWINDOW = 0x40;
  static void Main(string[] a) {
    int pid = int.Parse(a[0]);
    int show = a.Length > 1 ? int.Parse(a[1]) : 9;
    IntPtr h = Process.GetProcessById(pid).MainWindowHandle;
    if (h == IntPtr.Zero) { Console.WriteLine("NO_HWND"); return; }
    IntPtr fg = GetForegroundWindow();
    uint pidTmp;
    uint ftid = GetWindowThreadProcessId(fg, out pidTmp);
    uint ctid = GetCurrentThreadId();
    bool attached = false;
    if (ftid != ctid) attached = AttachThreadInput(ftid, ctid, true);
    ShowWindow(h, show);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    if (attached) AttachThreadInput(ftid, ctid, false);
    bool ok = GetForegroundWindow() == h;
    Console.WriteLine("FOCUS " + pid + " show=" + show + " ok=" + ok);
  }
}
