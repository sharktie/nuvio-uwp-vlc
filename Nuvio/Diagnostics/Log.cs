using System;
using System.Diagnostics;
using System.IO;
using Windows.Storage;

namespace Nuvio.Diagnostics
{
    /// <summary>
    /// Plain-text log of startup and playback in the app's LocalState folder. On Xbox, download it
    /// from Device Portal: File explorer > LocalAppData > (this app's package) > LocalState.
    /// </summary>
    internal static class Log
    {
        private const string FileName = "nuvio-vlc.log";
        private const string PreviousFileName = "nuvio-vlc.previous.log";
        private const long MaxChars = 1024 * 1024;
        private static readonly object Sync = new object();
        private static string _path;
        private static long _written;

        public static void Start()
        {
            try
            {
                var folder = ApplicationData.Current.LocalFolder.Path;
                _path = Path.Combine(folder, FileName);
                if (File.Exists(_path))
                {
                    File.Copy(_path, Path.Combine(folder, PreviousFileName), true);
                    File.Delete(_path);
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine("Log start failed: " + ex);
            }
        }

        public static void Write(string message)
        {
            var line = DateTime.Now.ToString("HH:mm:ss.fff") + " " + message;
            Debug.WriteLine(line);
            lock (Sync)
            {
                if (_path == null || _written > MaxChars)
                {
                    return;
                }
                try
                {
                    File.AppendAllText(_path, line + Environment.NewLine);
                    _written += line.Length + 2;
                }
                catch (Exception ex)
                {
                    Debug.WriteLine("Log write failed: " + ex.Message);
                }
            }
        }

        public static void Error(string context, Exception ex)
        {
            Write(context + ": " + ex);
        }

        /// <summary>The end of this run's log, or the previous run's, for showing in the app.</summary>
        public static string ReadRecent(bool previous, int maxChars)
        {
            try
            {
                var path = Path.Combine(ApplicationData.Current.LocalFolder.Path, previous ? PreviousFileName : FileName);
                if (!File.Exists(path))
                {
                    return string.Empty;
                }
                string text;
                lock (Sync)
                {
                    using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var reader = new StreamReader(stream))
                    {
                        text = reader.ReadToEnd();
                    }
                }
                return text.Length > maxChars ? text.Substring(text.Length - maxChars) : text;
            }
            catch (Exception ex)
            {
                return "Couldn't read the log: " + ex.Message;
            }
        }

        /// <summary>Scheme, host and the start of the path only, so links with tokens don't end up in the log.</summary>
        public static string DescribeUrl(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri))
            {
                return "(invalid url)";
            }
            var path = uri.AbsolutePath.Length > 24 ? uri.AbsolutePath.Substring(0, 24) + "..." : uri.AbsolutePath;
            return uri.Scheme + "://" + uri.Authority + path;
        }
    }
}
