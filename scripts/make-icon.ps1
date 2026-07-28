Add-Type -AssemblyName System.Drawing

$size = 256
$bitmap = New-Object System.Drawing.Bitmap $size, $size
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$background = New-Object System.Drawing.Drawing2D.GraphicsPath
$background.AddArc(0, 0, 112, 112, 180, 90)
$background.AddArc(144, 0, 112, 112, 270, 90)
$background.AddArc(144, 144, 112, 112, 0, 90)
$background.AddArc(0, 144, 112, 112, 90, 90)
$background.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#16161a'))
$graphics.FillPath($brush, $background)
$brush.Dispose()

function Draw-Line($color, $width, $points) {
  $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml($color)), $width
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $graphics.DrawLines($pen, $points)
  $pen.Dispose()
}

Draw-Line '#d97757' 24 @(
  (New-Object System.Drawing.Point 104, 74),
  (New-Object System.Drawing.Point 56, 128),
  (New-Object System.Drawing.Point 104, 182)
)
Draw-Line '#4caf6e' 24 @(
  (New-Object System.Drawing.Point 152, 74),
  (New-Object System.Drawing.Point 200, 128),
  (New-Object System.Drawing.Point 152, 182)
)
Draw-Line '#e8e6e3' 17 @(
  (New-Object System.Drawing.Point 141, 64),
  (New-Object System.Drawing.Point 115, 192)
)

$output = Join-Path $PSScriptRoot '..\build\icon.ico'
$bitmap.Save((Join-Path $PSScriptRoot '..\build\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$stream = [System.IO.File]::Create($output)
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$icon.Save($stream)
$stream.Dispose()
$icon.Dispose()
$background.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
