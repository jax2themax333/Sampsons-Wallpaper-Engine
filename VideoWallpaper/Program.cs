
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace VideoWallpaper
{
    internal static class Program
    {
        private static readonly string LogPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            "SampsonsVideoWallpaperLog.txt"
        );

        private static void Log(string message)
        {
            try
            {
                File.AppendAllText(
                    LogPath,
                    $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}{Environment.NewLine}"
                );
            }
            catch
            {
                // Keep the helper running even if logging fails.
            }
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr FindWindow(
            string? className, string? windowName);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr FindWindowEx(
            IntPtr parent, IntPtr after,
            string? className, string? windowName);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetParent(IntPtr window);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetWindow(
            IntPtr window, uint command);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(
            IntPtr window, out uint processId);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SendMessageTimeout(
            IntPtr window, uint message, IntPtr wParam,
            IntPtr lParam, uint flags, uint timeout,
            out IntPtr result);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool EnumWindows(
            EnumWindowsProc callback, IntPtr parameter);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool EnumChildWindows(
            IntPtr parent, EnumWindowsProc callback, IntPtr parameter);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetParent(
            IntPtr child, IntPtr newParent);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
        private static extern IntPtr GetWindowLongPtr(
            IntPtr window, int index);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
        private static extern IntPtr SetWindowLongPtr(
            IntPtr window, int index, IntPtr value);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(
            IntPtr window, IntPtr after,
            int x, int y, int width, int height, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern int GetClassName(
            IntPtr window, StringBuilder className, int maxCount);

        private delegate bool EnumWindowsProc(
            IntPtr window, IntPtr parameter);

        private const uint WM_SPAWN_WORKER = 0x052C;
        private const int GWL_STYLE = -16;
        private const long WS_CHILD = 0x40000000L;
        private const long WS_POPUP = unchecked((long)0x80000000);
        private const uint SWP_FRAMECHANGED = 0x0020;
        private const uint SWP_SHOWWINDOW = 0x0040;
        private const uint SWP_NOZORDER = 0x0004;

        static int Main(string[] args)
        {
            try
            {
                Log("");
                Log("========== VIDEO WALLPAPER HELPER STARTED ==========");
                Log("Windows version: " + Environment.OSVersion);
                Log("64-bit process: " + Environment.Is64BitProcess);
                Log("Arguments received: " + args.Length);

                if (args.Length != 1 ||
                    !long.TryParse(args[0], out long handle))
                {
                    Log("ERROR: Invalid window handle.");
                    return 1;
                }

                IntPtr videoWindow = new IntPtr(handle);
                Log("Video window handle: " + videoWindow);

                if (!IsWindow(videoWindow))
                {
                    Log("ERROR: The supplied video window does not exist.");
                    return 1;
                }

                IntPtr progman = FindWindow("Progman", null);
                Log("Progman handle: " + progman);

                if (progman == IntPtr.Zero)
                {
                    Log("ERROR: Could not find Progman.");
                    Log("Windows error: " + Marshal.GetLastWin32Error());
                    return 1;
                }

                IntPtr messageResult;

                SendMessageTimeout(
                    progman,
                    WM_SPAWN_WORKER,
                    new IntPtr(0xD),
                    new IntPtr(0x1),
                    0,
                    1000,
                    out messageResult
                );

                Log("Worker spawn message result: " + messageResult);

                IntPtr desktopWorker = IntPtr.Zero;
                IntPtr foundShellView = IntPtr.Zero;

                EnumWindows((topWindow, _) =>
                {
                    var className = new StringBuilder(256);
                    GetClassName(topWindow, className, className.Capacity);

                    IntPtr shellView = FindWindowEx(
                        topWindow,
                        IntPtr.Zero,
                        "SHELLDLL_DefView",
                        null
                    );

                    if (shellView != IntPtr.Zero)
                    {
                        foundShellView = shellView;

                        Log("Found desktop icon window.");
                        Log("Top-level window: " + topWindow);
                        Log("Window class: " + className);
                        Log("Shell view: " + shellView);

                        desktopWorker = FindWindowEx(
                            progman,
                            IntPtr.Zero,
                            "WorkerW",
                            null
                        );

                        Log("WorkerW inside Progman: " + desktopWorker);

                        return false;
                    }

                    return true;
                }, IntPtr.Zero);

                Log("Desktop shell view found: " + foundShellView);
                Log("Selected WorkerW: " + desktopWorker);

                Log("========== WORKERW WINDOW INSPECTION ==========");

                EnumWindows((window, _) =>
                {
                    var className = new StringBuilder(256);
                    GetClassName(window, className, className.Capacity);

                    if (className.ToString() == "WorkerW")
                    {
                        Log("WorkerW found: " + window);
                        Log("Parent: " + GetParent(window));
                        Log("Next window: " + GetWindow(window, 2));
                        Log("Previous window: " + GetWindow(window, 3));

                        IntPtr child = GetWindow(window, 5);

                        var childClass = new StringBuilder(256);

                        if (child != IntPtr.Zero)
                        {
                            GetClassName(child, childClass, childClass.Capacity);
                        }

                        Log("First child: " + child);
                        Log("Child class: " + childClass);
                    }

                    return true;
                }, IntPtr.Zero);

                if (desktopWorker == IntPtr.Zero)
                {
                    Log("ERROR: Could not find the selected WorkerW.");
                    return 1;
                }

                Log("========== ATTACHMENT PROCESS ==========");

                long style = GetWindowLongPtr(
                    videoWindow,
                    GWL_STYLE
                ).ToInt64();

                Log("Original window style: " + style);
                Log("GetWindowLongPtr error: " + Marshal.GetLastWin32Error());

                style = (style & ~WS_POPUP) | WS_CHILD;

                SetLastError(0);

                IntPtr previousStyle = SetWindowLongPtr(
                    videoWindow,
                    GWL_STYLE,
                    new IntPtr(style)
                );

                int styleError = Marshal.GetLastWin32Error();

                Log("SetWindowLongPtr previous value: " + previousStyle);
                Log("SetWindowLongPtr error: " + styleError);

                SetLastError(0);

                IntPtr previousParent = SetParent(
                    videoWindow,
                    desktopWorker
                );

                int parentError = Marshal.GetLastWin32Error();

                Log("Previous parent: " + previousParent);
                Log("SetParent error: " + parentError);

                int width = ScreenWidth();
                int height = ScreenHeight();

                Log("Screen width: " + width);
                Log("Screen height: " + height);

                bool resized = SetWindowPos(
                    videoWindow,
                    IntPtr.Zero,
                    -5,
                    0,
                    width + 10,
                    height,
                    SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW
                );

                int resizeError = Marshal.GetLastWin32Error();

                Log("SetWindowPos success: " + resized);
                Log("SetWindowPos error: " + resizeError);

                if (!resized)
                {
                    Log("ERROR: Failed to resize video window.");
                    return 1;
                }

                Log("SUCCESS: Desktop attachment attempted.");
                Log("========== HELPER FINISHED ==========");

                return 0;
            }
            catch (Exception ex)
            {
                Log("UNHANDLED EXCEPTION:");
                Log(ex.ToString());
                return 1;
            }
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool IsWindow(IntPtr window);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern void SetLastError(uint error);

        private static int ScreenWidth() =>
            System.Windows.Forms.Screen.PrimaryScreen!.Bounds.Width;

        private static int ScreenHeight() =>
            System.Windows.Forms.Screen.PrimaryScreen!.Bounds.Height;
    }
}