using System;
using System.Threading.Tasks;
using Nuvio.Diagnostics;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.UI;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Media;
using Windows.UI.Xaml.Navigation;

namespace Nuvio
{
    sealed partial class App : Application
    {
        public App()
        {
            Log.Start();
            Log.Write("App starting, version " + VersionText());
            this.UnhandledException += OnUnhandledException;
            TaskScheduler.UnobservedTaskException += (s, e) => Log.Error("Unobserved task exception", e.Exception);

            // WebView2 reads these when it starts its browser process, so they must be set before the
            // first page loads. A transparent background lets the VLC video under the page show through.
            Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0");
            // Let the app reach addons and servers on the local network over plain http
            // (e.g. a self-hosted addon at http://192.168.1.10:7000), which browsers block on an https page.
            Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--autoplay-policy=no-user-gesture-required --allow-running-insecure-content " +
                "--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights," +
                "PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks");

            this.InitializeComponent();
        }

        protected override void OnLaunched(LaunchActivatedEventArgs e)
        {
            // Xbox: use the whole screen instead of the TV-safe area so video fills the TV. The web
            // app keeps its controls inside the safe area itself.
            ApplicationView.GetForCurrentView().SetDesiredBoundsMode(ApplicationViewBoundsMode.UseCoreWindow);

            var rootFrame = Window.Current.Content as Frame;
            if (rootFrame == null)
            {
                rootFrame = new Frame();
                rootFrame.NavigationFailed += OnNavigationFailed;
                Window.Current.Content = rootFrame;
            }

            if (e.PrelaunchActivated == false)
            {
                if (rootFrame.Content == null)
                {
                    try
                    {
                        rootFrame.Navigate(typeof(MainPage), e.Arguments);
                    }
                    catch (Exception ex)
                    {
                        Log.Error("Main page failed to load", ex);
                        ShowFatalError(ex);
                    }
                }
                Window.Current.Activate();
                Log.Write("Window activated");
            }
        }

        private void OnUnhandledException(object sender, Windows.UI.Xaml.UnhandledExceptionEventArgs e)
        {
            Log.Write("Unhandled exception: " + e.Message + Environment.NewLine + e.Exception);
            e.Handled = true;
            var page = (Window.Current.Content as Frame)?.Content as MainPage;
            if (page == null || !page.TryRecoverFromVideoFailure(e.Exception))
            {
                ShowFatalError(e.Exception);
            }
        }

        // Shows what went wrong instead of leaving the console on the splash screen.
        private static void ShowFatalError(Exception error)
        {
            var text = new TextBlock
            {
                Text = "Nuvio hit an error and can't continue. Please send this to the developer:" +
                    Environment.NewLine + Environment.NewLine + "Version " + VersionText() + Environment.NewLine + error,
                Foreground = new SolidColorBrush(Colors.White),
                TextWrapping = TextWrapping.Wrap,
                IsTextSelectionEnabled = true,
                Margin = new Thickness(48),
            };
            Window.Current.Content = new ScrollViewer
            {
                Content = text,
                Background = new SolidColorBrush(Colors.Black),
            };
            Window.Current.Activate();
        }

        private static string VersionText()
        {
            var version = Package.Current.Id.Version;
            return string.Format("{0}.{1}.{2}.{3}", version.Major, version.Minor, version.Build, version.Revision);
        }

        private void OnNavigationFailed(object sender, NavigationFailedEventArgs e)
        {
            throw new Exception("Failed to load Page " + e.SourcePageType.FullName);
        }
    }
}
