using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace FlowcytoGateEditorWindow;

internal sealed class MainForm : Form
{
    private readonly WindowOptions options;
    private readonly WebView2 webView;
    private bool readyWritten;

    public MainForm(WindowOptions options)
    {
        this.options = options;

        Text = options.Title;
        StartPosition = FormStartPosition.CenterScreen;
        Width = options.Width;
        Height = options.Height;
        MinimumSize = new Size(360, 360);

        webView = new WebView2
        {
            Dock = DockStyle.Fill,
            AllowExternalDrop = false
        };

        Controls.Add(webView);
        Shown += async (_, _) => await InitializeWebViewAsync();
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            CoreWebView2Environment.GetAvailableBrowserVersionString();

            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Datalox",
                "FlowcytoMcp",
                "WebView2");

            Directory.CreateDirectory(userDataFolder);

            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: userDataFolder,
                options: null);

            await webView.EnsureCoreWebView2Async(environment);

            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.Settings.IsZoomControlEnabled = true;

            webView.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) || !Program.IsAllowedPreviewUri(uri))
                {
                    args.Cancel = true;
                }
            };

            webView.CoreWebView2.NavigationCompleted += (_, args) =>
            {
                if (readyWritten) return;
                readyWritten = true;

                if (args.IsSuccess)
                {
                    Program.WriteReady();
                    return;
                }

                Program.WriteError(new NativeWindowError(
                    "native_window_navigation_failed",
                    "/surface/url",
                    $"WebView2 failed to load the local preview URL: {args.WebErrorStatus}."));
                Close();
            };

            webView.CoreWebView2.Navigate(options.Url.ToString());
        }
        catch (WebView2RuntimeNotFoundException)
        {
            Program.WriteError(new NativeWindowError(
                "webview2_runtime_missing",
                "/surface/runtime",
                "Microsoft Edge WebView2 Runtime is required for the Windows native gate editor window."));
            Close();
        }
        catch (Exception error)
        {
            Program.WriteError(new NativeWindowError(
                "native_window_failed",
                "/surface",
                error.Message));
            Close();
        }
    }
}
