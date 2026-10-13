using System;
using Windows.Gaming.Input;
using Windows.UI.Xaml;

namespace Nuvio.Input
{
    /// <summary>
    /// Reads the controller and hands the web app named actions ("up", "select", "back", ...).
    /// Inside WebView2 on Xbox the page never sees the A or B buttons, so the app reads them here
    /// and the page's own focus navigation acts on them (web/js/core/focus.js).
    /// </summary>
    internal sealed class ControllerBridge : IDisposable
    {
        private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(30);
        private static readonly TimeSpan FirstRepeatDelay = TimeSpan.FromMilliseconds(400);
        private static readonly TimeSpan RepeatInterval = TimeSpan.FromMilliseconds(110);
        private const double StickThreshold = 0.6;
        private const double TriggerThreshold = 0.5;

        private static readonly ButtonAction[] Buttons =
        {
            new ButtonAction(GamepadButtons.A, "select"),
            new ButtonAction(GamepadButtons.B, "back"),
            new ButtonAction(GamepadButtons.X, "x"),
            new ButtonAction(GamepadButtons.Y, "y"),
            new ButtonAction(GamepadButtons.Menu, "menu"),
            new ButtonAction(GamepadButtons.View, "view"),
            new ButtonAction(GamepadButtons.LeftShoulder, "lb"),
            new ButtonAction(GamepadButtons.RightShoulder, "rb"),
        };

        private readonly Action<string, bool> _send;
        private readonly DispatcherTimer _timer = new DispatcherTimer();
        private GamepadButtons _previousButtons;
        private bool _previousLeftTrigger;
        private bool _previousRightTrigger;
        private string _heldDirection;
        private DateTime _nextRepeat;

        /// <param name="send">Called on the UI thread with an action name and whether it is a held-down repeat.</param>
        public ControllerBridge(Action<string, bool> send)
        {
            _send = send;
            // Buttons already down at start (e.g. the A press that launched the app) don't count.
            var reading = Read();
            _previousButtons = reading.Buttons;
            _previousLeftTrigger = reading.LeftTrigger;
            _previousRightTrigger = reading.RightTrigger;
            _timer.Interval = PollInterval;
            _timer.Tick += OnTick;
            _timer.Start();
        }

        /// <summary>While true the controller is left to XAML, e.g. for a dialog or the load error screen.</summary>
        public bool Paused { get; set; }

        public void Dispose()
        {
            _timer.Stop();
        }

        private void OnTick(object sender, object e)
        {
            var reading = Read();
            var pressed = reading.Buttons & ~_previousButtons;
            var leftTriggerPressed = reading.LeftTrigger && !_previousLeftTrigger;
            var rightTriggerPressed = reading.RightTrigger && !_previousRightTrigger;
            _previousButtons = reading.Buttons;
            _previousLeftTrigger = reading.LeftTrigger;
            _previousRightTrigger = reading.RightTrigger;
            if (Paused)
            {
                _heldDirection = null;
                return;
            }

            var now = DateTime.UtcNow;
            if (reading.Direction != _heldDirection)
            {
                _heldDirection = reading.Direction;
                if (reading.Direction != null)
                {
                    _send(reading.Direction, false);
                    _nextRepeat = now + FirstRepeatDelay;
                }
            }
            else if (reading.Direction != null && now >= _nextRepeat)
            {
                _send(reading.Direction, true);
                _nextRepeat = now + RepeatInterval;
            }

            foreach (var button in Buttons)
            {
                if ((pressed & button.Button) != 0)
                {
                    _send(button.Name, false);
                }
            }
            if (leftTriggerPressed)
            {
                _send("lt", false);
            }
            if (rightTriggerPressed)
            {
                _send("rt", false);
            }
        }

        private static ControllerReading Read()
        {
            var result = new ControllerReading();
            foreach (var gamepad in Gamepad.Gamepads)
            {
                var reading = gamepad.GetCurrentReading();
                result.Buttons |= reading.Buttons;
                result.LeftTrigger |= reading.LeftTrigger > TriggerThreshold;
                result.RightTrigger |= reading.RightTrigger > TriggerThreshold;
                if (result.Direction == null)
                {
                    result.Direction = GetDirection(reading);
                }
            }
            return result;
        }

        private static string GetDirection(GamepadReading reading)
        {
            if ((reading.Buttons & GamepadButtons.DPadUp) != 0) return "up";
            if ((reading.Buttons & GamepadButtons.DPadDown) != 0) return "down";
            if ((reading.Buttons & GamepadButtons.DPadLeft) != 0) return "left";
            if ((reading.Buttons & GamepadButtons.DPadRight) != 0) return "right";
            var x = reading.LeftThumbstickX;
            var y = reading.LeftThumbstickY;
            if (Math.Abs(x) < StickThreshold && Math.Abs(y) < StickThreshold)
            {
                return null;
            }
            if (Math.Abs(y) >= Math.Abs(x))
            {
                return y > 0 ? "up" : "down";
            }
            return x > 0 ? "right" : "left";
        }

        private sealed class ControllerReading
        {
            public GamepadButtons Buttons;
            public bool LeftTrigger;
            public bool RightTrigger;
            public string Direction;
        }

        private struct ButtonAction
        {
            public ButtonAction(GamepadButtons button, string name)
            {
                Button = button;
                Name = name;
            }

            public GamepadButtons Button;
            public string Name;
        }
    }
}
