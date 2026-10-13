using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using LibVLCSharp.Shared;
using Nuvio.Diagnostics;
using Windows.Web.Http;
using Windows.Web.Http.Filters;

namespace Nuvio.Playback
{
    /// <summary>
    /// Feeds VLC a stream downloaded with Windows' own HTTP stack instead of VLC's. VLC's UWP build
    /// failed to open every https link on the Xbox within a fraction of a second, while Windows'
    /// stack handles certificates, redirects (e.g. addon to debrid server) and TLS itself. It also
    /// sends any request headers a stream asks for, which LibVLC 3 can't (only User-Agent and Referer).
    /// Seeking is done with HTTP range requests.
    /// </summary>
    /// <remarks>VLC calls Open, Read, Seek and Close on its input thread, one at a time.</remarks>
    internal sealed class HttpMediaInput : MediaInput
    {
        private const string DefaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NuvioUWP-VLC";
        private static readonly HttpClient Client = CreateClient();

        private readonly object _sync = new object();
        private readonly IDictionary<string, string> _headers;
        private readonly byte[] _buffer = new byte[256 * 1024];
        private Uri _uri;
        private HttpResponseMessage _response;
        private Stream _body;
        private ulong _position;
        private ulong _length;
        private bool _supportsRanges;
        private bool _aborted;
        private bool _retriedRead;

        public HttpMediaInput(string url, IDictionary<string, string> headers)
        {
            _uri = new Uri(url);
            _headers = headers ?? new Dictionary<string, string>();
            CanSeek = true;
        }

        /// <summary>Breaks off a pending read so VLC can stop without waiting for the network.</summary>
        public void Abort()
        {
            lock (_sync)
            {
                _aborted = true;
                CloseResponse();
            }
        }

        public override bool Open(out ulong size)
        {
            try
            {
                OpenAt(0);
                Log.Write("Opened stream: " + (_length > 0 ? Math.Round(_length / 1048576.0) + " MB" : "unknown size") +
                    (_supportsRanges ? ", seekable" : ", not seekable") + ", from " + Log.DescribeUrl(_uri.AbsoluteUri));
                size = _length;
                return true;
            }
            catch (Exception ex)
            {
                Log.Error("Opening the stream failed", ex);
                size = 0;
                return false;
            }
        }

        public override int Read(IntPtr buf, uint len)
        {
            try
            {
                var read = ReadOnce(len);
                _retriedRead = false;
                return read;
            }
            catch (Exception ex)
            {
                if (_aborted)
                {
                    return -1;
                }
                // A dropped connection: pick the download back up where it stopped, once.
                if (!_retriedRead && _supportsRanges && (_length == 0 || _position < _length))
                {
                    _retriedRead = true;
                    Log.Write("Stream read failed (" + ex.Message + "), resuming at " + _position);
                    try
                    {
                        OpenAt(_position);
                        return ReadOnce(len);
                    }
                    catch (Exception retryEx)
                    {
                        Log.Error("Resuming the stream failed", retryEx);
                    }
                }
                else
                {
                    Log.Error("Stream read failed", ex);
                }
                return -1;
            }

            int ReadOnce(uint length)
            {
                var body = _body;
                if (body == null)
                {
                    throw new IOException("No response");
                }
                var read = body.Read(_buffer, 0, (int)Math.Min(length, (uint)_buffer.Length));
                if (read > 0)
                {
                    Marshal.Copy(_buffer, 0, buf, read);
                    _position += (ulong)read;
                }
                return read;
            }
        }

        public override bool Seek(ulong offset)
        {
            if (offset == _position && _body != null)
            {
                return true;
            }
            if (!_supportsRanges)
            {
                return false;
            }
            try
            {
                OpenAt(offset);
                return true;
            }
            catch (Exception ex)
            {
                Log.Error("Seeking the stream failed", ex);
                return false;
            }
        }

        public override void Close()
        {
            lock (_sync)
            {
                CloseResponse();
            }
        }

        private void OpenAt(ulong offset)
        {
            lock (_sync)
            {
                CloseResponse();
                if (_aborted)
                {
                    throw new OperationCanceledException();
                }
            }

            var request = new HttpRequestMessage(HttpMethod.Get, _uri);
            request.Headers.TryAppendWithoutValidation("Range", "bytes=" + offset + "-");
            var hasUserAgent = false;
            foreach (var header in _headers)
            {
                if (string.IsNullOrWhiteSpace(header.Key) || header.Key.Equals("Range", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                hasUserAgent |= header.Key.Equals("User-Agent", StringComparison.OrdinalIgnoreCase);
                request.Headers.TryAppendWithoutValidation(header.Key, header.Value ?? string.Empty);
            }
            if (!hasUserAgent)
            {
                request.Headers.TryAppendWithoutValidation("User-Agent", DefaultUserAgent);
            }
            var response = Client.SendRequestAsync(request, HttpCompletionOption.ResponseHeadersRead).AsTask().GetAwaiter().GetResult();
            if (!response.IsSuccessStatusCode)
            {
                var status = (int)response.StatusCode + " " + response.ReasonPhrase;
                response.Dispose();
                throw new IOException("HTTP " + status);
            }

            // Keep using the address the redirects led to, so seeks skip the addon's redirect.
            if (response.RequestMessage != null && response.RequestMessage.RequestUri != null)
            {
                _uri = response.RequestMessage.RequestUri;
            }
            var range = response.Content.Headers.ContentRange;
            if (response.StatusCode == HttpStatusCode.PartialContent && range != null && range.Length.HasValue)
            {
                _length = range.Length.Value;
                _supportsRanges = true;
            }
            else
            {
                if (offset > 0)
                {
                    response.Dispose();
                    throw new IOException("The server doesn't support seeking");
                }
                _length = response.Content.Headers.ContentLength ?? 0;
                _supportsRanges = false;
            }

            var body = response.Content.ReadAsInputStreamAsync().AsTask().GetAwaiter().GetResult().AsStreamForRead(0);
            lock (_sync)
            {
                if (_aborted)
                {
                    body.Dispose();
                    response.Dispose();
                    throw new OperationCanceledException();
                }
                _response = response;
                _body = body;
                _position = offset;
            }
        }

        private void CloseResponse()
        {
            _body?.Dispose();
            _body = null;
            _response?.Dispose();
            _response = null;
        }

        private static HttpClient CreateClient()
        {
            var filter = new HttpBaseProtocolFilter { AllowAutoRedirect = true, AutomaticDecompression = false };
            // Don't let Windows cache gigabytes of video.
            filter.CacheControl.ReadBehavior = HttpCacheReadBehavior.NoCache;
            filter.CacheControl.WriteBehavior = HttpCacheWriteBehavior.NoCache;
            return new HttpClient(filter);
        }
    }
}
