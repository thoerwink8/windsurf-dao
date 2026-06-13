using System;
using System.Runtime.InteropServices;
// dao_click：在屏幕绝对坐标处左键单击（SetCursorPos + mouse_event）。
// 用法：dao_click.exe <x> <y>
// 坐标是屏幕绝对像素（左上角原点）；配合 dao_shot 全屏截图定位坐标。
// 点击前通常先用 dao_focus 把目标窗口抬到前台，否则点击会落到当前前台窗口。
class C {
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  const uint LD = 0x02, LU = 0x04;
  static void Main(string[] a) {
    int x = int.Parse(a[0]), y = int.Parse(a[1]);
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(LD, 0, 0, 0, IntPtr.Zero);
    mouse_event(LU, 0, 0, 0, IntPtr.Zero);
    Console.WriteLine("CLICK " + x + "," + y);
  }
}
