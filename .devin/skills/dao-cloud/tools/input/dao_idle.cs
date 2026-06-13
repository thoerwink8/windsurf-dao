using System;
using System.Runtime.InteropServices;
// dao_idle：打印系统空闲毫秒（自上次键鼠输入以来）。
// 用于「实时桌面交互礼仪」的 idle 闸门：idle 小（用户在操作）就停 ~10 秒，够大才抢焦点截图。
// 用法：dao_idle.exe  -> stdout 一个整数（毫秒）
class I {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  static void Main() {
    var l = new LASTINPUTINFO(); l.cbSize = (uint)Marshal.SizeOf(l);
    GetLastInputInfo(ref l);
    uint idle = (uint)Environment.TickCount - l.dwTime;
    Console.WriteLine(idle);
  }
}
