param(
    [ValidateSet('image', 'pixels', 'pdf')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$InputPath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [int]$Page = 1,
    [int]$MaxDimension = 2400
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class DrawingImageBridge {
    public static object Process(string input, string output, bool pixels, int maximum) {
        using (Image source = Image.FromFile(input)) {
            try {
                if (Array.IndexOf(source.PropertyIdList, 0x112) >= 0) {
                    int orientation = source.GetPropertyItem(0x112).Value[0];
                    RotateFlipType[] rotations = {
                        RotateFlipType.RotateNoneFlipNone, RotateFlipType.RotateNoneFlipNone,
                        RotateFlipType.RotateNoneFlipX, RotateFlipType.Rotate180FlipNone,
                        RotateFlipType.Rotate180FlipX, RotateFlipType.Rotate90FlipX,
                        RotateFlipType.Rotate90FlipNone, RotateFlipType.Rotate270FlipX,
                        RotateFlipType.Rotate270FlipNone
                    };
                    if (orientation >= 1 && orientation <= 8) source.RotateFlip(rotations[orientation]);
                }
            } catch (ArgumentException) { }
            if (source.Width < 1 || source.Height < 1 || source.Width > 20000 ||
                source.Height > 20000 || (long)source.Width * source.Height > 32000000)
                throw new InvalidDataException("Image dimensions exceed the supported limit.");
            double scale = maximum > 0 ? Math.Min(1.0, (double)maximum / Math.Max(source.Width, source.Height)) : 1.0;
            int width = Math.Max(1, (int)Math.Round(source.Width * scale));
            int height = Math.Max(1, (int)Math.Round(source.Height * scale));
            using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
                using (Graphics graphics = Graphics.FromImage(bitmap)) {
                    graphics.Clear(Color.White);
                    graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    graphics.DrawImage(source, new Rectangle(0, 0, width, height));
                }
                float dpi = source.HorizontalResolution;
                if (float.IsNaN(dpi) || float.IsInfinity(dpi) || dpi < 1 || dpi > 2400) dpi = 96;
                bitmap.SetResolution(dpi, dpi);
                if (pixels) {
                    byte[] gray = new byte[width * height];
                    BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                    try {
                        byte[] row = new byte[Math.Abs(data.Stride)];
                        for (int y = 0; y < height; y++) {
                            Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                            for (int x = 0; x < width; x++) {
                                int offset = x * 3;
                                gray[y * width + x] = (byte)((77 * row[offset + 2] + 150 * row[offset + 1] + 29 * row[offset]) >> 8);
                            }
                        }
                    } finally { bitmap.UnlockBits(data); }
                    File.WriteAllBytes(output, gray);
                } else bitmap.Save(output, ImageFormat.Png);
                return new { width = width, height = height, dpi = dpi,
                    source_width = source.Width, source_height = source.Height };
            }
        }
    }
}
'@

if ($Mode -ne 'pdf') {
    [DrawingImageBridge]::Process($InputPath, $OutputPath, ($Mode -eq 'pixels'), $MaxDimension) | ConvertTo-Json -Compress
    exit 0
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType=WindowsRuntime]
$genericTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$actionTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
} | Select-Object -First 1
function Await-Operation($Operation, [Type]$ResultType) {
    $task = $genericTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait()
    return $task.Result
}
$file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($InputPath)) ([Windows.Storage.StorageFile])
$document = Await-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
if ($document.PageCount -lt 1 -or $document.PageCount -gt 1000) { throw 'PDF page count is outside the supported range.' }
if ($Page -lt 1 -or $Page -gt $document.PageCount) { throw 'PDF page number is outside the document.' }
$pdfPage = $document.GetPage($Page - 1)
$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
try {
    $size = $pdfPage.Size
    if ($size.Width -le 0 -or $size.Height -le 0) { throw 'PDF page has invalid dimensions.' }
    $scale = [Math]::Min(4.0, $MaxDimension / [Math]::Max($size.Width, $size.Height))
    $width = [Math]::Max(1, [int][Math]::Round($size.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($size.Height * $scale))
    $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $options.DestinationWidth = $width
    $options.DestinationHeight = $height
    $task = $actionTask.Invoke($null, @($pdfPage.RenderToStreamAsync($stream, $options)))
    $task.Wait()
    $reader = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
    $destination = [System.IO.File]::Create($OutputPath)
    try { $reader.CopyTo($destination) } finally { $destination.Dispose(); $reader.Dispose() }
    # WinRT may apply the monitor's DPI scaling to DestinationWidth/Height.
    # Report the saved raster dimensions, so editable vertices match its pixels.
    $raster = [System.Drawing.Image]::FromFile($OutputPath)
    try { $width=$raster.Width; $height=$raster.Height } finally { $raster.Dispose() }
    @{width=$width; height=$height; dpi=($width / $size.Width * 96); page=$Page;
        pages=[int]$document.PageCount; source_width=$size.Width; source_height=$size.Height;
        renderer='windows-pdf'} | ConvertTo-Json -Compress
} finally { $pdfPage.Dispose(); $stream.Dispose() }
