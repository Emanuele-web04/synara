param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System.Runtime.InteropServices;
public static class NativeInputState {
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
}
'@
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Synara Windows Cua CI'
$form.SetBounds(100, 100, 640, 400)
$inputBox = New-Object System.Windows.Forms.TextBox
$inputBox.Multiline = $true
$inputBox.Dock = 'Fill'
$form.Controls.Add($inputBox)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 20
$timer.Add_Tick({
    $commandPath = Join-Path $Directory 'command.txt'
    if (Test-Path $commandPath) {
        $command = [System.IO.File]::ReadAllText($commandPath)
        Remove-Item $commandPath
        if ($command -eq 'escape') { [System.Windows.Forms.SendKeys]::SendWait('{ESC}') }
        if ($command -eq 'close') { $form.Close(); return }
    }
    $state = @{
        pid = $PID; window_id = $form.Handle.ToInt64(); text = $inputBox.Text
        left = [NativeInputState]::GetAsyncKeyState(1) -lt 0
        shift = [NativeInputState]::GetAsyncKeyState(16) -lt 0
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText((Join-Path $Directory 'state.json'), $state)
})
$form.Add_Shown({ $inputBox.Focus(); $timer.Start() })
[System.Windows.Forms.Application]::Run($form)
$timer.Dispose()
$form.Dispose()
