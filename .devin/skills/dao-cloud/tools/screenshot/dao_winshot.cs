using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
// dao_winshot：按窗口（PID 的主窗口句柄）截图，用 PrintWindow，不抢前台焦点。
// 用法：dao_winshot.exe <pid> [outPath] [quality]
// 适合在不打断用户的前提下抓单个窗口；若窗口被最小化/遮挡可能为空，
// 需要可见时配合 dao_focus 先把目标窗口抬到前台再用 dao_shot 全屏截。
class W {
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  static void Main(string[] a) {
    int pid = int.Parse(a[0]);
    string outPath = a.Length > 1 ? a[1] : System.Environment.ExpandEnvironmentVariables(@"%USERPROFILE%\.dao\bin\win_shot.jpg");
    long q = a.Length > 2 ? long.Parse(a[2]) : 70L;
    IntPtr h = System.Diagnostics.Process.GetProcessById(pid).MainWindowHandle;
    if (h == IntPtr.Zero) { Console.WriteLine("NO_HWND"); return; }
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, ht = r.B - r.T;
    using (var bmp = new Bitmap(w, ht)) {
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        PrintWindow(h, hdc, 2u);
        g.ReleaseHdc(hdc);
      }
      ImageCodecInfo jpg = null;
      foreach (var e in ImageCodecInfo.GetImageEncoders()) if (e.MimeType == "image/jpeg") jpg = e;
      var ep = new EncoderParameters(1);
      ep.Param[0] = new EncoderParameter(Encoder.Quality, q);
      bmp.Save(outPath, jpg, ep);
    }
    Console.WriteLine("WINSHOT_OK " + w + "x" + ht + " -> " + outPath);
  }
}
