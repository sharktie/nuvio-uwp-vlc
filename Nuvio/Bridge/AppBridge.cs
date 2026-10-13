using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;
using Nuvio.Diagnostics;
using Nuvio.Playback;
using Windows.ApplicationModel;
using Windows.Data.Json;
using Windows.Storage.Streams;
using Windows.System;
using Windows.System.Profile;
using Windows.Web.Http;
using Windows.Web.Http.Filters;

namespace Nuvio.Bridge
{
    /// <summary>A text box in the page that the user selected with the controller.</summary>
    internal sealed class TextEntryRequest
    {
        public TextEntryRequest(string label, string kind, string value)
        {
            Label = label;
            Kind = kind;
            Value = value;
        }

        public string Label { get; }
        /// <summary>"text", "password", "email", "url", "search" or "number".</summary>
        public string Kind { get; }
        public string Value { get; }
    }

    /// <summary>What the user typed, and whether they finished with the keyboard's Enter key.</summary>
    internal sealed class TextEntryResult
    {
        public TextEntryResult(string text, bool submitted)
        {
            Text = text;
            Submitted = submitted;
        }

        public string Text { get; }
        public bool Submitted { get; }
    }

    /// <summary>The parts of the app window the bridge needs.</summary>
    internal interface IAppHost
    {
        Task<TextEntryResult> RequestTextAsync(TextEntryRequest request);
        void SetPointerMode(bool enabled);
        /// <summary>Saves a developer web app address (null for the built-in app) and reloads.</summary>
        void SetWebAppUrl(string url);
        string WebAppUrl { get; }
        bool IsBundledWebApp { get; }
    }

    /// <summary>
    /// Native side of the messages between the Nuvio web app and the app (documented in
    /// docs/bridge.md). The page posts JSON objects with window.chrome.webview.postMessage and
    /// gets JSON objects back as "message" events.
    /// </summary>
    internal sealed class AppBridge : IDisposable
    {
        private const int MaxFetchBytes = 16 * 1024 * 1024;
        private static readonly bool IsXbox = AnalyticsInfo.VersionInfo.DeviceFamily == "Windows.Xbox";
        private static readonly HttpClient FetchClient = CreateFetchClient();

        private readonly CoreWebView2 _webView;
        private readonly VlcPlayer _player;
        private readonly IAppHost _host;
        private readonly Uri _trustedOrigin;

        public AppBridge(CoreWebView2 webView, VlcPlayer player, IAppHost host, Uri trustedOrigin)
        {
            _webView = webView;
            _player = player;
            _host = host;
            _trustedOrigin = trustedOrigin;
            _webView.WebMessageReceived += OnWebMessageReceived;
            _player.EventRaised += Send;
        }

        public void Dispose()
        {
            _webView.WebMessageReceived -= OnWebMessageReceived;
            _player.EventRaised -= Send;
        }

        /// <summary>Sends a controller action, e.g. "select", to the page.</summary>
        public void SendInput(string action, bool repeat)
        {
            var payload = new JsonObject();
            payload.SetNamedValue("action", JsonValue.CreateStringValue(action));
            payload.SetNamedValue("repeat", JsonValue.CreateBooleanValue(repeat));
            Send("input", payload);
        }

        public void SendVisibility(bool visible)
        {
            var payload = new JsonObject();
            payload.SetNamedValue("visible", JsonValue.CreateBooleanValue(visible));
            Send("app.visibility", payload);
        }

        private void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsTrustedSource(e.Source))
            {
                return;
            }
            try
            {
                JsonObject message;
                if (!JsonObject.TryParse(e.WebMessageAsJson, out message))
                {
                    return;
                }
                var type = GetString(message, "type");
                if (type == null)
                {
                    return;
                }
                if (type.StartsWith("player.", StringComparison.Ordinal))
                {
                    HandlePlayer(type, message);
                }
                else
                {
                    HandleApp(type, message);
                }
            }
            catch (Exception ex)
            {
                Log.Error("Bridge message failed", ex);
            }
        }

        private void HandlePlayer(string type, JsonObject message)
        {
            switch (type)
            {
                case "player.open":
                    var request = new OpenRequest
                    {
                        Id = GetString(message, "id") ?? string.Empty,
                        Url = GetString(message, "url"),
                        StartSeconds = GetNumber(message, "start", 0),
                        HardwareDecoding = GetBool(message, "hwdec", true),
                    };
                    var headers = message.GetNamedValue("headers", JsonValue.CreateNullValue());
                    if (headers.ValueType == JsonValueType.Object)
                    {
                        foreach (var header in headers.GetObject())
                        {
                            if (header.Value.ValueType == JsonValueType.String)
                            {
                                request.Headers[header.Key] = header.Value.GetString();
                            }
                        }
                    }
                    _player.Open(request);
                    break;
                case "player.stop":
                    _player.Stop();
                    break;
                case "player.pause":
                    _player.SetPaused(GetBool(message, "paused", true));
                    break;
                case "player.play":
                    _player.SetPaused(false);
                    break;
                case "player.toggle":
                    _player.TogglePause();
                    break;
                case "player.seek":
                    _player.Seek(GetNumber(message, "time", -1));
                    break;
                case "player.volume":
                    _player.SetVolume((int)Math.Round(GetNumber(message, "volume", 100)));
                    break;
                case "player.mute":
                    _player.SetMute(GetBool(message, "muted", false));
                    break;
                case "player.rate":
                    _player.SetRate(GetNumber(message, "rate", 1));
                    break;
                case "player.audioTrack":
                    _player.SetAudioTrack((int)GetNumber(message, "trackId", -1));
                    break;
                case "player.subtitleTrack":
                    _player.SetSubtitleTrack((int)GetNumber(message, "trackId", -1));
                    break;
                case "player.subtitleDelay":
                    _player.SetSubtitleDelay((long)GetNumber(message, "ms", 0));
                    break;
                case "player.audioDelay":
                    _player.SetAudioDelay((long)GetNumber(message, "ms", 0));
                    break;
                case "player.aspect":
                    _player.SetAspect(GetString(message, "mode"));
                    break;
            }
        }

        private void HandleApp(string type, JsonObject message)
        {
            switch (type)
            {
                case "app.hello":
                    Log.Write("Web app connected");
                    SendHello();
                    break;
                case "app.log":
                    Log.Write("page: " + GetString(message, "message"));
                    break;
                case "app.textInput":
                    RequestText(message);
                    break;
                case "app.openExternal":
                    OpenExternal(GetString(message, "url"));
                    break;
                case "app.pointer":
                    _host.SetPointerMode(GetBool(message, "enabled", false));
                    break;
                case "app.setWebAppUrl":
                    _host.SetWebAppUrl(GetString(message, "url"));
                    break;
                case "app.exit":
                    Windows.UI.Xaml.Application.Current.Exit();
                    break;
                case "net.fetch":
                    Fetch(message);
                    break;
            }
        }

        private void SendHello()
        {
            var version = Package.Current.Id.Version;
            var payload = new JsonObject();
            payload.SetNamedValue("platform", JsonValue.CreateStringValue(IsXbox ? "xbox" : "desktop"));
            payload.SetNamedValue("appVersion", JsonValue.CreateStringValue(
                string.Format("{0}.{1}.{2}", version.Major, version.Minor, version.Build)));
            payload.SetNamedValue("vlcVersion", _player.Version != null ? JsonValue.CreateStringValue(_player.Version) : JsonValue.CreateNullValue());
            payload.SetNamedValue("webAppUrl", _host.WebAppUrl != null ? JsonValue.CreateStringValue(_host.WebAppUrl) : JsonValue.CreateNullValue());
            payload.SetNamedValue("bundled", JsonValue.CreateBooleanValue(_host.IsBundledWebApp));
            Send("app.hello", payload);
        }

        private async void RequestText(JsonObject message)
        {
            var requestId = GetString(message, "requestId");
            JsonObject result = null;
            try
            {
                var entry = await _host.RequestTextAsync(new TextEntryRequest(
                    GetString(message, "label") ?? string.Empty,
                    GetString(message, "kind") ?? "text",
                    GetString(message, "value") ?? string.Empty));
                if (entry != null)
                {
                    result = new JsonObject();
                    result.SetNamedValue("text", JsonValue.CreateStringValue(entry.Text ?? string.Empty));
                    result.SetNamedValue("submitted", JsonValue.CreateBooleanValue(entry.Submitted));
                }
            }
            catch (Exception ex)
            {
                Log.Error("Text entry failed", ex);
            }
            Respond(requestId, result, null);
        }

        // Fetches a URL for the page without the browser's CORS rules, e.g. subtitle files from
        // servers that don't send CORS headers. Text responses only.
        private async void Fetch(JsonObject message)
        {
            var requestId = GetString(message, "requestId");
            var url = GetString(message, "url");
            Uri uri;
            if (url == null || !Uri.TryCreate(url, UriKind.Absolute, out uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                Respond(requestId, null, "Invalid URL");
                return;
            }
            try
            {
                var method = (GetString(message, "method") ?? "GET").ToUpperInvariant();
                var request = new HttpRequestMessage(new HttpMethod(method), uri);
                var headers = message.GetNamedValue("headers", JsonValue.CreateNullValue());
                string contentType = null;
                if (headers.ValueType == JsonValueType.Object)
                {
                    foreach (var header in headers.GetObject())
                    {
                        if (header.Value.ValueType != JsonValueType.String)
                        {
                            continue;
                        }
                        if (header.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase))
                        {
                            contentType = header.Value.GetString();
                            continue;
                        }
                        request.Headers.TryAppendWithoutValidation(header.Key, header.Value.GetString());
                    }
                }
                var body = GetString(message, "body");
                if (body != null && method != "GET" && method != "HEAD")
                {
                    request.Content = new HttpStringContent(body, UnicodeEncoding.Utf8, "application/json");
                    Windows.Web.Http.Headers.HttpMediaTypeHeaderValue parsedType;
                    // Parsed whole so parameters such as a multipart boundary are kept.
                    if (contentType != null && Windows.Web.Http.Headers.HttpMediaTypeHeaderValue.TryParse(contentType, out parsedType))
                    {
                        request.Content.Headers.ContentType = parsedType;
                    }
                }
                using (var response = await FetchClient.SendRequestAsync(request, HttpCompletionOption.ResponseHeadersRead))
                {
                    var length = response.Content.Headers.ContentLength;
                    if (length.HasValue && length.Value > MaxFetchBytes)
                    {
                        Respond(requestId, null, "Response too large");
                        return;
                    }
                    var buffer = await response.Content.ReadAsBufferAsync();
                    if (buffer.Length > MaxFetchBytes)
                    {
                        Respond(requestId, null, "Response too large");
                        return;
                    }
                    var bytes = new byte[buffer.Length];
                    using (var reader = DataReader.FromBuffer(buffer))
                    {
                        reader.ReadBytes(bytes);
                    }
                    var result = new JsonObject();
                    result.SetNamedValue("status", JsonValue.CreateNumberValue((int)response.StatusCode));
                    result.SetNamedValue("url", JsonValue.CreateStringValue(
                        response.RequestMessage?.RequestUri?.AbsoluteUri ?? uri.AbsoluteUri));
                    var responseHeaders = new JsonObject();
                    foreach (var header in response.Headers)
                    {
                        responseHeaders.SetNamedValue(header.Key.ToLowerInvariant(), JsonValue.CreateStringValue(header.Value));
                    }
                    foreach (var header in response.Content.Headers)
                    {
                        responseHeaders.SetNamedValue(header.Key.ToLowerInvariant(), JsonValue.CreateStringValue(header.Value));
                    }
                    result.SetNamedValue("headers", responseHeaders);
                    // Base64 so the page can decode text in whatever charset it is in.
                    result.SetNamedValue("bodyBase64", JsonValue.CreateStringValue(Convert.ToBase64String(bytes)));
                    Respond(requestId, result, null);
                }
            }
            catch (Exception ex)
            {
                Log.Write("Fetch failed for " + Log.DescribeUrl(url) + ": " + ex.Message);
                Respond(requestId, null, ex.Message);
            }
        }

        private void Respond(string requestId, JsonObject result, string error)
        {
            if (requestId == null)
            {
                return;
            }
            var payload = new JsonObject();
            payload.SetNamedValue("requestId", JsonValue.CreateStringValue(requestId));
            payload.SetNamedValue("result", result != null ? (IJsonValue)result : JsonValue.CreateNullValue());
            if (error != null)
            {
                payload.SetNamedValue("error", JsonValue.CreateStringValue(error));
            }
            Send("response", payload);
        }

        private void Send(string type, JsonObject payload)
        {
            try
            {
                payload.SetNamedValue("type", JsonValue.CreateStringValue(type));
                _webView.PostWebMessageAsJson(payload.Stringify());
            }
            catch (Exception ex)
            {
                Log.Write("Bridge post failed: " + ex.Message);
            }
        }

        private bool IsTrustedSource(string source)
        {
            Uri uri;
            return Uri.TryCreate(source, UriKind.Absolute, out uri) &&
                uri.Scheme == _trustedOrigin.Scheme &&
                string.Equals(uri.Host, _trustedOrigin.Host, StringComparison.OrdinalIgnoreCase) &&
                uri.Port == _trustedOrigin.Port;
        }

        internal static void OpenExternal(string url)
        {
            Uri uri;
            if (url != null && Uri.TryCreate(url, UriKind.Absolute, out uri) &&
                (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp))
            {
                var ignored = Launcher.LaunchUriAsync(uri);
            }
        }

        private static string GetString(JsonObject message, string name)
        {
            var value = message.GetNamedValue(name, JsonValue.CreateNullValue());
            return value.ValueType == JsonValueType.String ? value.GetString() : null;
        }

        private static double GetNumber(JsonObject message, string name, double fallback)
        {
            var value = message.GetNamedValue(name, JsonValue.CreateNullValue());
            return value.ValueType == JsonValueType.Number ? value.GetNumber() : fallback;
        }

        private static bool GetBool(JsonObject message, string name, bool fallback)
        {
            var value = message.GetNamedValue(name, JsonValue.CreateNullValue());
            return value.ValueType == JsonValueType.Boolean ? value.GetBoolean() : fallback;
        }

        private static HttpClient CreateFetchClient()
        {
            var filter = new HttpBaseProtocolFilter { AllowAutoRedirect = true };
            filter.CacheControl.WriteBehavior = HttpCacheWriteBehavior.NoCache;
            return new HttpClient(filter);
        }
    }
}
