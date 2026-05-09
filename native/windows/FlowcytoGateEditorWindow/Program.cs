using System.Text.Json;
using System.Windows.Forms;

namespace FlowcytoGateEditorWindow;

internal static class Program
{
    private const string RequiredPreviewPath = "/mcp-app-preview";

    [STAThread]
    private static void Main(string[] args)
    {
        if (!TryParseArgs(args, out var options, out var error))
        {
            WriteError(error);
            Environment.Exit(2);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(options));
    }

    private static bool TryParseArgs(
        string[] args,
        out WindowOptions options,
        out NativeWindowError error)
    {
        options = default!;
        error = default!;

        if (args.Length < 1)
        {
            error = NativeWindowError.InvalidArgs("Missing /mcp-app-preview URL.");
            return false;
        }

        if (!Uri.TryCreate(args[0], UriKind.Absolute, out var uri) || !IsAllowedPreviewUri(uri))
        {
            error = new NativeWindowError(
                "native_window_url_not_local",
                "/surface/url",
                "Windows native preview only accepts http://127.0.0.1:<port>/mcp-app-preview or http://localhost:<port>/mcp-app-preview.");
            return false;
        }

        var title = args.Length > 1 && args[1].Length > 0
            ? args[1]
            : "Flowcyto Gate Editor";
        var width = ParseBoundedInt(args, 2, 620, 360, 2200);
        var height = ParseBoundedInt(args, 3, 640, 360, 1800);

        options = new WindowOptions(uri, title, width, height);
        return true;
    }

    private static int ParseBoundedInt(string[] args, int index, int fallback, int min, int max)
    {
        if (args.Length <= index || !int.TryParse(args[index], out var value))
        {
            return fallback;
        }

        return Math.Clamp(value, min, max);
    }

    internal static bool IsAllowedPreviewUri(Uri uri)
    {
        return uri.Scheme == Uri.UriSchemeHttp
            && uri.AbsolutePath == RequiredPreviewPath
            && (uri.Host == "127.0.0.1" || uri.Host == "localhost")
            && !uri.IsDefaultPort;
    }

    internal static void WriteReady()
    {
        Console.Out.WriteLine("flowcyto_native_window_ready");
        Console.Out.Flush();
    }

    internal static void WriteError(NativeWindowError error)
    {
        Console.Out.Write("flowcyto_native_window_error ");
        Console.Out.WriteLine(JsonSerializer.Serialize(error));
        Console.Out.Flush();
    }
}

internal sealed record WindowOptions(Uri Url, string Title, int Width, int Height);

internal sealed record NativeWindowError(string code, string path, string message)
{
    public static NativeWindowError InvalidArgs(string message)
        => new("native_window_invalid_args", "/surface", message);
}
