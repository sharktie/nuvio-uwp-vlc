using System;
using System.IO;
using System.Threading.Tasks;
using LibVLCSharp.Platforms.Windows;
using Microsoft.Web.WebView2.Core;
using Nuvio.Bridge;
using Nuvio.Diagnostics;
using Nuvio.Input;
using Nuvio.Playback;
using Windows.ApplicationModel;
using Windows.Storage;
using Windows.System;
using Windows.UI.Core;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Input;
using Windows.UI.Xaml.Markup;
using Windows.UI.Xaml.Media;
using Windows.UI.Xaml.Navigation;

namespace Nuvio
{
    /// <summary>
    /// The Nuvio web app (web/ in the repository, packaged into the app) runs in a WebView2 on top
    /// of a VLC video surface, and plays streams with VLC through <see cref="AppBridge"/>.
    /// </summary>
    public sealed partial class MainPage : Page, IAppHost
    {
        /// <summary>The packaged web app is served from this made-up https origin.</summary>
        private const string BundledHost = "app.nuvio.local";
        private static readonly Uri BundledUri = new Uri("https://" + BundledHost + "/index.html");
        private const string WebAppUrlSetting = "webAppUrl";

        private readonly VlcPlayer _player;
        private AppBridge _bridge;
        private ControllerBridge _controller;
        private Uri _appUri;
        private bool _servingBundleManually;
        private ulong _appNavigationId;
        private bool _videoViewRequested;
        private bool _videoViewStarting;
        private bool _dialogOpen;

        public MainPage()
        {
            Log.Write("Main page starting");
            this.InitializeComponent();
            _player = new VlcPlayer(Dispatcher);
            _player.MediaPlayerCreated += mediaPlayer =>
            {
                if (VideoView != null)
                {
                    VideoView.MediaPlayer = mediaPlayer;
                }
            };
            _player.VideoVisibleChanged += visible =>
            {
                if (VideoView != null)
                {
                    VideoView.Opacity = visible ? 1 : 0;
                }
            };
            // The page has its own focus navigation for the controller; the console's mouse-mode
            // cursor would only get in the way. The web app can turn it back on.
            SetPointerMode(false);
            PreviewKeyDown += OnPreviewKeyDown;
            Loaded += OnLoaded;
        }

        public string WebAppUrl
        {
            get
            {
                return ApplicationData.Current.LocalSettings.Values[WebAppUrlSetting] as string;
            }
        }

        public bool IsBundledWebApp
        {
            get { return _appUri == null || _appUri.Host == BundledHost; }
        }

        /// <summary>
        /// Called for an unhandled exception. If it came from the VLC video surface while it was
        /// starting, drop the surface and keep the app running without VLC playback.
        /// </summary>
        internal bool TryRecoverFromVideoFailure(Exception error)
        {
            if (!_videoViewStarting)
            {
                return false;
            }
            _videoViewStarting = false;
            Log.Write("The VLC video surface failed to start; continuing without VLC playback");
            try
            {
                if (VideoView != null)
                {
                    XamlMarkupHelper.UnloadObject(VideoView);
                }
            }
            catch (Exception ex)
            {
                Log.Error("Removing the VLC video surface failed", ex);
            }
            _player.SetUnavailable("the video surface failed to start (" + error.Message + ")");
            return true;
        }

        protected override void OnNavigatedFrom(NavigationEventArgs e)
        {
            base.OnNavigatedFrom(e);
            SystemNavigationManager.GetForCurrentView().BackRequested -= OnBackRequested;
            Window.Current.VisibilityChanged -= OnWindowVisibilityChanged;
            _controller?.Dispose();
            _bridge?.Dispose();
            _player.Dispose();
        }

        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            Loaded -= OnLoaded;
            Log.Write("Main page loaded, starting WebView2");
            SystemNavigationManager.GetForCurrentView().BackRequested += OnBackRequested;
            Window.Current.VisibilityChanged += OnWindowVisibilityChanged;
            try
            {
                await WebView.EnsureCoreWebView2Async();
            }
            catch (Exception ex)
            {
                Log.Error("WebView2 failed to start", ex);
                ShowLoadError("The web view could not start. " + ex.Message, false);
                return;
            }
            Log.Write("WebView2 ready");

            var core = WebView.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            // No browser shortcuts such as the back key: B is handled by ControllerBridge only.
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsPinchZoomEnabled = false;
#if !DEBUG
            core.Settings.AreDevToolsEnabled = false;
#endif
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NewWindowRequested += OnNewWindowRequested;
            core.ProcessFailed += OnProcessFailed;
            ServeBundledApp(core);

            _appUri = ChooseAppUri();
            // Must be listening before the page loads: the web app says hello as soon as it starts.
            _bridge = new AppBridge(core, _player, this, _appUri);
            _controller = new ControllerBridge((action, repeat) => _bridge.SendInput(action, repeat));
            Log.Write("Loading " + Log.DescribeUrl(_appUri.AbsoluteUri));
            core.Navigate(_appUri.AbsoluteUri);
            WebView.Focus(FocusState.Programmatic);
        }

        private Uri ChooseAppUri()
        {
            Uri custom;
            var url = WebAppUrl;
            if (!string.IsNullOrWhiteSpace(url) && Uri.TryCreate(url, UriKind.Absolute, out custom) &&
                (custom.Scheme == Uri.UriSchemeHttp || custom.Scheme == Uri.UriSchemeHttps))
            {
                return custom;
            }
            return BundledUri;
        }

        // Serves the web/ folder of the package at https://app.nuvio.local/. The browser maps the
        // folder itself when it can; otherwise the files are answered from here.
        private void ServeBundledApp(CoreWebView2 core)
        {
            var folder = Path.Combine(Package.Current.InstalledLocation.Path, "web");
            try
            {
                core.SetVirtualHostNameToFolderMapping(BundledHost, folder, CoreWebView2HostResourceAccessKind.Allow);
                Log.Write("Serving the web app from " + folder);
            }
            catch (Exception ex)
            {
                Log.Error("Folder mapping is unavailable, serving the web app from the app", ex);
                ServeBundleManually(core);
            }
        }

        private void ServeBundleManually(CoreWebView2 core)
        {
            if (_servingBundleManually)
            {
                return;
            }
            _servingBundleManually = true;
            core.AddWebResourceRequestedFilter("https://" + BundledHost + "/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnBundleResourceRequested;
        }

        private async void OnBundleResourceRequested(CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            Uri uri;
            if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out uri) || uri.Host != BundledHost)
            {
                return;
            }
            var deferral = e.GetDeferral();
            try
            {
                var path = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
                if (path.Length == 0)
                {
                    path = "index.html";
                }
                if (path.Contains(".."))
                {
                    e.Response = sender.Environment.CreateWebResourceResponse(null, 403, "Forbidden", string.Empty);
                    return;
                }
                StorageFile file;
                try
                {
                    file = await StorageFile.GetFileFromApplicationUriAsync(new Uri("ms-appx:///web/" + path));
                }
                catch (FileNotFoundException)
                {
                    e.Response = sender.Environment.CreateWebResourceResponse(null, 404, "Not Found", string.Empty);
                    return;
                }
                // A native WinRT stream: a wrapped .NET stream is read back through the UI thread.
                var stream = await file.OpenReadAsync();
                e.Response = sender.Environment.CreateWebResourceResponse(stream, 200, "OK",
                    "Content-Type: " + ContentTypeFor(path) + "\nCache-Control: no-cache");
            }
            catch (Exception ex)
            {
                Log.Error("Serving " + e.Request.Uri + " failed", ex);
            }
            finally
            {
                deferral.Complete();
            }
        }

        private static string ContentTypeFor(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": case ".mjs": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": case ".webmanifest": return "application/json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".webp": return "image/webp";
                case ".ico": return "image/x-icon";
                case ".woff2": return "font/woff2";
                case ".woff": return "font/woff";
                case ".ttf": return "font/ttf";
                default: return "application/octet-stream";
            }
        }

        public void SetPointerMode(bool enabled)
        {
            Log.Write("Pointer mode " + (enabled ? "on" : "off"));
            var mode = enabled ? RequiresPointer.WhenFocused : RequiresPointer.Never;
            RequiresPointer = mode;
            WebView.RequiresPointer = mode;
        }

        public void SetWebAppUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url))
            {
                ApplicationData.Current.LocalSettings.Values.Remove(WebAppUrlSetting);
                Log.Write("Using the built-in web app");
            }
            else
            {
                ApplicationData.Current.LocalSettings.Values[WebAppUrlSetting] = url.Trim();
                Log.Write("Using the web app at " + Log.DescribeUrl(url));
            }
            ReloadPage();
        }

        private void ReloadPage()
        {
            // A fresh page also recovers from a crashed browser process.
            Frame.Navigate(typeof(MainPage));
            Frame.BackStack.Clear();
        }

        private void EnsureWebViewFocus()
        {
            if (LoadErrorPanel.Visibility != Visibility.Collapsed || _dialogOpen)
            {
                return;
            }
            for (var element = FocusManager.GetFocusedElement() as DependencyObject; element != null; element = VisualTreeHelper.GetParent(element))
            {
                if (element == WebView)
                {
                    return;
                }
            }
            WebView.Focus(FocusState.Programmatic);
        }

        // Lets the user type into a text box in the page with the console's on-screen keyboard,
        // which reliably works with a XAML text box.
        async Task<TextEntryResult> IAppHost.RequestTextAsync(TextEntryRequest request)
        {
            if (_dialogOpen)
            {
                return null;
            }
            var isPassword = request.Kind == "password";
            var passwordBox = new PasswordBox { Password = isPassword ? request.Value ?? string.Empty : string.Empty };
            var textBox = new TextBox { Text = request.Value ?? string.Empty, IsSpellCheckEnabled = false };
            var scopeName = InputScopeFor(request.Kind);
            if (scopeName.HasValue)
            {
                var scope = new InputScope();
                scope.Names.Add(new InputScopeName(scopeName.Value));
                textBox.InputScope = scope;
            }
            Control input = isPassword ? (Control)passwordBox : textBox;

            var dialog = new ContentDialog
            {
                Title = string.IsNullOrWhiteSpace(request.Label) ? "Enter text" : request.Label,
                Content = input,
                PrimaryButtonText = "OK",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
            };
            var submitted = false;
            // Accepting the on-screen keyboard sends Enter: treat that as OK.
            input.KeyDown += (s, e) =>
            {
                if (e.Key == VirtualKey.Enter)
                {
                    e.Handled = true;
                    submitted = true;
                    dialog.Hide();
                }
            };
            // Ask for the keyboard whenever the box gets focus, and again shortly after the dialog
            // opens: a password box isn't always ready for it straight away.
            input.GotFocus += (s, e) => ShowOnScreenKeyboard();
            dialog.Opened += async (s, e) =>
            {
                input.Focus(FocusState.Keyboard);
                textBox.SelectAll();
                await Task.Delay(TimeSpan.FromMilliseconds(200));
                if (input.FocusState == FocusState.Unfocused)
                {
                    input.Focus(FocusState.Keyboard);
                }
                ShowOnScreenKeyboard();
            };

            _dialogOpen = true;
            if (_controller != null)
            {
                _controller.Paused = true;
            }
            ContentDialogResult result;
            try
            {
                result = await dialog.ShowAsync();
            }
            finally
            {
                _dialogOpen = false;
                if (_controller != null)
                {
                    _controller.Paused = LoadErrorPanel.Visibility != Visibility.Collapsed;
                }
                WebView.Focus(FocusState.Programmatic);
            }
            if (result != ContentDialogResult.Primary && !submitted)
            {
                return null;
            }
            return new TextEntryResult(isPassword ? passwordBox.Password : textBox.Text, submitted);
        }

        private static InputScopeNameValue? InputScopeFor(string kind)
        {
            switch (kind)
            {
                case "email": return InputScopeNameValue.EmailSmtpAddress;
                case "url": return InputScopeNameValue.Url;
                case "search": return InputScopeNameValue.Search;
                case "number": return InputScopeNameValue.Number;
                default: return null;
            }
        }

        private static void ShowOnScreenKeyboard()
        {
            try
            {
                InputPane.GetForCurrentView().TryShow();
            }
            catch (Exception ex)
            {
                Log.Error("Showing the on-screen keyboard failed", ex);
            }
        }

        private void OnPreviewKeyDown(object sender, KeyRoutedEventArgs e)
        {
            // ControllerBridge handles the controller. Stop XAML from also using its buttons to move
            // focus out of the web page, except on the load error screen where they work its buttons.
            var key = (int)e.Key;
            var isController = (key >= (int)VirtualKey.GamepadA && key <= (int)VirtualKey.GamepadRightThumbstickLeft) ||
                (key >= (int)VirtualKey.NavigationView && key <= (int)VirtualKey.NavigationCancel);
            if (isController && LoadErrorPanel.Visibility == Visibility.Collapsed)
            {
                e.Handled = true;
                EnsureWebViewFocus();
            }
        }

        // Realizes the x:Load="False" VideoView. Done after the web app loads so that a problem in
        // VLC's video surface can't keep the app from starting.
        private void CreateVideoView()
        {
            if (_videoViewRequested)
            {
                return;
            }
            _videoViewRequested = true;
            try
            {
                Log.Write("Creating the VLC video surface");
                _videoViewStarting = true;
                FindName(nameof(VideoView));
                VideoView.Initialized += VideoView_Initialized;
            }
            catch (Exception ex)
            {
                _videoViewStarting = false;
                Log.Error("Creating the VLC video surface failed", ex);
                _player.SetUnavailable("the video surface could not be created (" + ex.Message + ")");
            }
        }

        private void VideoView_Initialized(object sender, InitializedEventArgs e)
        {
            _videoViewStarting = false;
            Log.Write("VLC video surface ready");
            _player.Initialize(e.SwapChainOptions);
        }

        private void VideoView_SizeChanged(object sender, SizeChangedEventArgs e)
        {
            _player.SetViewSize(e.NewSize.Width, e.NewSize.Height);
        }

        private void OnNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (IsWebApp(e.Uri))
            {
                _appNavigationId = e.NavigationId;
                return;
            }
            Log.Write("Opening outside the app: " + Log.DescribeUrl(e.Uri));
            e.Cancel = true;
            AppBridge.OpenExternal(e.Uri);
        }

        private void OnNavigationCompleted(CoreWebView2 sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.NavigationId != _appNavigationId)
            {
                return;
            }
            Log.Write("Web app load finished: " + (e.IsSuccess ? "success" : e.WebErrorStatus.ToString()));
            if (e.IsSuccess)
            {
                LoadErrorPanel.Visibility = Visibility.Collapsed;
                if (_controller != null)
                {
                    _controller.Paused = false;
                }
                EmulatePageFocus(sender);
                CreateVideoView();
            }
            else if (e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
            {
                if (IsBundledWebApp && !_servingBundleManually)
                {
                    // The browser couldn't read the mapped folder; answer the requests from here.
                    Log.Write("Retrying the built-in web app without folder mapping");
                    ServeBundleManually(sender);
                    sender.Navigate(BundledUri.AbsoluteUri);
                    return;
                }
                ShowLoadError(IsBundledWebApp
                    ? "The built-in web app failed to load. (" + e.WebErrorStatus + ")"
                    : "Couldn't reach the web app at " + _appUri.Authority + ". (" + e.WebErrorStatus + ")", !IsBundledWebApp);
            }
        }

        // Without the console's mouse-mode cursor nothing ever clicks into the page, so the browser
        // treats it as unfocused (document.hasFocus() is false and text boxes ignore typing).
        private static async void EmulatePageFocus(CoreWebView2 core)
        {
            try
            {
                await core.CallDevToolsProtocolMethodAsync("Emulation.setFocusEmulationEnabled", "{\"enabled\":true}");
            }
            catch (Exception ex)
            {
                Log.Error("Page focus emulation failed", ex);
            }
        }

        private void OnNewWindowRequested(CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            if (IsWebApp(e.Uri))
            {
                sender.Navigate(e.Uri);
            }
            else
            {
                AppBridge.OpenExternal(e.Uri);
            }
        }

        private void OnProcessFailed(CoreWebView2 sender, CoreWebView2ProcessFailedEventArgs e)
        {
            Log.Write("WebView2 process failed: " + e.ProcessFailedKind);
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited ||
                e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
            {
                _player.Stop();
                sender.Reload();
            }
            else if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                ShowLoadError("The web view stopped unexpectedly.", false);
            }
        }

        private void OnBackRequested(object sender, BackRequestedEventArgs e)
        {
            // ControllerBridge already handles B; handling it here too would go back twice, and
            // leaving it unhandled would close the app.
            if (LoadErrorPanel.Visibility == Visibility.Collapsed)
            {
                e.Handled = true;
            }
        }

        private void OnWindowVisibilityChanged(object sender, VisibilityChangedEventArgs e)
        {
            _bridge?.SendVisibility(e.Visible);
        }

        private void RetryButton_Click(object sender, RoutedEventArgs e)
        {
            ReloadPage();
        }

        private void BuiltInButton_Click(object sender, RoutedEventArgs e)
        {
            SetWebAppUrl(null);
        }

        private void ShowLoadError(string message, bool offerBuiltIn)
        {
            LoadErrorText.Text = message;
            BuiltInButton.Visibility = offerBuiltIn ? Visibility.Visible : Visibility.Collapsed;
            LoadErrorPanel.Visibility = Visibility.Visible;
            if (_controller != null)
            {
                _controller.Paused = true;
            }
            RetryButton.Focus(FocusState.Programmatic);
        }

        private bool IsWebApp(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || _appUri == null)
            {
                return false;
            }
            return uri.Scheme == _appUri.Scheme &&
                string.Equals(uri.Host, _appUri.Host, StringComparison.OrdinalIgnoreCase) &&
                uri.Port == _appUri.Port;
        }
    }
}
