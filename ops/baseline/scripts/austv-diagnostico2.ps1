<#
  AusTV - Diagnostico 2: funil por PLATAFORMA + retencao retroativa D1/D7/D30
  Descoberta que habilita isso: o Quests grava started-date / completion-date.
  Nao modifica nada. So le.

  RODAR:
    powershell -ExecutionPolicy Bypass -File D:\AUSTV\clone_survival\austv-diagnostico2.ps1
#>
$ErrorActionPreference = 'Stop'

$Base     = 'D:\AUSTV\clone_survival'
$UserData = Join-Path $Base 'Essentials\userdata'
$QuestsPD = Join-Path $Base 'Quests\playerdata'
$TutDir   = Join-Path $Base 'Quests\quests\tutorial'

$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$OutFile = Join-Path $root 'austv-diagnostico2-saida.txt'

$out = New-Object System.Text.StringBuilder
function W($t) { [void]$out.AppendLine([string]$t); Write-Host $t }
function Pct($a,$b) { if ($b -le 0) { return '  0.0%' }; '{0,6:N1}%' -f (100.0*$a/$b) }
function PlatOf($name) {
    if ($name.StartsWith('00000000-0000-0000-0009-')) { return 'bedrock' }
    if ($name.Length -ge 15 -and $name[14] -eq '3')   { return 'java_offline' }
    if ($name.Length -ge 15 -and $name[14] -eq '4')   { return 'java_premium' }
    return 'outro'
}
$PLATS = @('bedrock','java_offline','java_premium')

W ("AusTV diagnostico 2 | {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'))
W ""

# ids do tutorial
$idSet = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($qf in [System.IO.Directory]::EnumerateFiles($TutDir,'*.yml')) {
    [void]$idSet.Add([System.IO.Path]::GetFileNameWithoutExtension($qf))
}

# ===========================================================================
# PASSO A - Quests playerdata
# ===========================================================================
Write-Host "Lendo Quests playerdata..." -ForegroundColor Cyan
$PDB = @{}                       # uuid -> objeto
$sw = [Diagnostics.Stopwatch]::StartNew()
$cnt = 0

foreach ($f in [System.IO.Directory]::EnumerateFiles($QuestsPD,'*.yml')) {
    $cnt++
    if ((New-Object System.IO.FileInfo $f).Length -eq 0) { continue }
    $uuid = [System.IO.Path]::GetFileNameWithoutExtension($f)

    $curId = $null; $curInd = -1; $curDone = $false; $curComp = 0L
    $firstAct = [int64]::MaxValue
    $doneSet  = New-Object 'System.Collections.Generic.HashSet[string]'
    $d01 = 0L; $d02 = 0L; $maxStep = -1

    foreach ($line in [System.IO.File]::ReadLines($f)) {
        if ($line.Trim().Length -eq 0) { continue }
        $ind = 0; while ($ind -lt $line.Length -and $line[$ind] -eq ' ') { $ind++ }
        $t = $line.Substring($ind)
        $ci = $t.IndexOf(':')
        if ($ci -le 0) { continue }
        $key = $t.Substring(0,$ci).Trim('"').Trim("'")
        $val = $t.Substring($ci+1).Trim()

        if ($curId -ne $null -and $ind -le $curInd) {
            if ($curDone) {
                [void]$doneSet.Add($curId)
                if ($curId -eq '01tutorial') { $d01 = $curComp }
                if ($curId -eq '02tutorial') { $d02 = $curComp }
                $m = [regex]::Match($curId,'^\d+'); if ($m.Success -and [int]$m.Value -gt $maxStep) { $maxStep = [int]$m.Value }
            }
            $curId = $null; $curDone = $false; $curComp = 0L
        }

        if ($idSet.Contains($key)) {
            $curId = $key; $curInd = $ind; $curDone = $false; $curComp = 0L
        }
        elseif ($key -eq 'completed' -and $val -eq 'true' -and $curId -ne $null) { $curDone = $true }
        elseif ($key -eq 'completion-date' -or $key -eq 'started-date') {
            $v = 0L
            if ([int64]::TryParse($val,[ref]$v) -and $v -gt 1000000000000L) {
                if ($v -lt $firstAct) { $firstAct = $v }
                if ($curId -ne $null -and $key -eq 'completion-date') { $curComp = $v }
            }
        }
    }
    if ($curId -ne $null -and $curDone) {
        [void]$doneSet.Add($curId)
        if ($curId -eq '01tutorial') { $d01 = $curComp }
        if ($curId -eq '02tutorial') { $d02 = $curComp }
        $m = [regex]::Match($curId,'^\d+'); if ($m.Success -and [int]$m.Value -gt $maxStep) { $maxStep = [int]$m.Value }
    }

    if ($doneSet.Count -eq 0 -and $firstAct -eq [int64]::MaxValue) { continue }

    $PDB[$uuid] = [PSCustomObject]@{
        plat     = PlatOf $uuid
        firstAct = $(if ($firstAct -eq [int64]::MaxValue) { 0L } else { $firstAct })
        d01      = $d01
        d02      = $d02
        maxStep  = $maxStep
        done     = $doneSet
        lastLogin= 0L
    }
    if ($cnt % 3000 -eq 0) { Write-Host ("  ... {0}" -f $cnt) -ForegroundColor DarkGray }
}
$sw.Stop()
W ("playerdata_com_dado: {0} de {1}  ({2:N0}s)" -f $PDB.Count, $cnt, $sw.Elapsed.TotalSeconds)
W ""

# ===========================================================================
# PASSO B - Essentials userdata: ultimo login + split de plataforma
# ===========================================================================
Write-Host "Lendo Essentials userdata..." -ForegroundColor Cyan
$sw2 = [Diagnostics.Stopwatch]::StartNew()
$totPlat = @{}; $ativPlat = @{}; $homePlat = @{}
foreach ($pl2 in $PLATS + @('outro')) { $totPlat[$pl2]=0; $ativPlat[$pl2]=0; $homePlat[$pl2]=0 }
$maxLogin = 0L; $nUD = 0
$tmpLogin = @{}

foreach ($f in [System.IO.Directory]::EnumerateFiles($UserData,'*.yml')) {
    $nUD++
    $uuid = [System.IO.Path]::GetFileNameWithoutExtension($f)
    $login = 0L; $homes = 0; $inTs=$false; $inHomes=$false
    $rd = [System.IO.File]::OpenText($f)
    try {
        while ($null -ne ($line = $rd.ReadLine())) {
            if ($line.Length -eq 0) { continue }
            if ($line[0] -ne ' ') { $inTs = $line.StartsWith('timestamps:'); $inHomes = $line.StartsWith('homes:'); continue }
            if ($inTs -and $line.StartsWith('  login: ')) { $login = [int64]$line.Substring(9).Trim() }
            elseif ($inHomes -and $line[2] -ne ' ') { $homes++ }
        }
    } finally { $rd.Dispose() }
    if ($login -gt $maxLogin) { $maxLogin = $login }
    $pl = PlatOf $uuid
    $totPlat[$pl]++
    if ($homes -gt 0) { $homePlat[$pl]++ }
    $tmpLogin[$uuid] = $login
    if ($nUD % 10000 -eq 0) { Write-Host ("  ... {0}" -f $nUD) -ForegroundColor DarkGray }
}
foreach ($k in $tmpLogin.Keys) {
    $lg = $tmpLogin[$k]
    if ($lg -gt 0 -and ($maxLogin - $lg) -le 2592000000L) { $ativPlat[(PlatOf $k)]++ }
    if ($PDB.ContainsKey($k)) { $PDB[$k].lastLogin = $lg }
}
$sw2.Stop()
W ("userdata_lidos: {0}  ({1:N0}s)" -f $nUD, $sw2.Elapsed.TotalSeconds)
W ""

W "--- PLATAFORMA: TODOS vs ATIVOS 30d vs COM HOME ---"
W ("{0,-14} {1,8} {2,7} {3,8} {4,7} {5,8} {6,7}" -f 'plataforma','todos','%','ativos30','%at','com_home','%hm')
foreach ($pl2 in ($PLATS + @('outro'))) {
    W ("{0,-14} {1,8} {2} {3,8} {4} {5,8} {6}" -f $pl2, $totPlat[$pl2], (Pct $totPlat[$pl2] $nUD), $ativPlat[$pl2], (Pct $ativPlat[$pl2] $totPlat[$pl2]), $homePlat[$pl2], (Pct $homePlat[$pl2] $totPlat[$pl2]))
}
W ""

# ===========================================================================
# FUNIL POR PLATAFORMA
# ===========================================================================
$steps = @('01tutorial','02tutorial','03tutorial','05tutorial','06tutorial','07tutorial','08tutorial','09tutorial','13tutorial','20tutorial','33tutorial')
$fbase = @{}; foreach ($pl2 in $PLATS) { $fbase[$pl2] = 0 }
foreach ($v in $PDB.Values) { if ($fbase.ContainsKey($v.plat)) { $fbase[$v.plat]++ } }

W "--- FUNIL DO TUTORIAL POR PLATAFORMA (base = quem tem playerdata com dado) ---"
W ("{0,-13} {1,10} {2,10} {3,10}" -f 'quest','bedrock','java_off','java_prem')
W ("{0,-13} {1,10} {2,10} {3,10}" -f 'BASE', $fbase['bedrock'], $fbase['java_offline'], $fbase['java_premium'])
foreach ($s in $steps) {
    $c = @{}; foreach ($pl2 in $PLATS) { $c[$pl2] = 0 }
    foreach ($v in $PDB.Values) { if ($v.done.Contains($s) -and $c.ContainsKey($v.plat)) { $c[$v.plat]++ } }
    W ("{0,-13} {1,4} {2} {3,4} {4} {5,4} {6}" -f $s, $c['bedrock'], (Pct $c['bedrock'] $fbase['bedrock']), $c['java_offline'], (Pct $c['java_offline'] $fbase['java_offline']), $c['java_premium'], (Pct $c['java_premium'] $fbase['java_premium']))
}
W ""

# ===========================================================================
# RETENCAO RETROATIVA (lifespan = ultimo login - primeira atividade)
# ===========================================================================
W "--- RETENCAO RETROATIVA: D1/D7/D30/D90 (base = tem firstAct + lastLogin) ---"
W ("{0,-14} {1,8} {2,8} {3,8} {4,8} {5,8}" -f 'plataforma','base','D1','D7','D30','D90')
$allB=0;$a1=0;$a7=0;$a30=0;$a90=0
foreach ($pl2 in $PLATS) {
    $b=0;$r1=0;$r7=0;$r30=0;$r90=0
    foreach ($v in $PDB.Values) {
        if ($v.plat -ne $pl2) { continue }
        if ($v.firstAct -le 0 -or $v.lastLogin -le 0) { continue }
        $d = ($v.lastLogin - $v.firstAct) / 86400000.0
        $b++
        if ($d -ge 1)  { $r1++ }
        if ($d -ge 7)  { $r7++ }
        if ($d -ge 30) { $r30++ }
        if ($d -ge 90) { $r90++ }
    }
    $allB+=$b;$a1+=$r1;$a7+=$r7;$a30+=$r30;$a90+=$r90
    W ("{0,-14} {1,8} {2} {3} {4} {5}" -f $pl2,$b,(Pct $r1 $b),(Pct $r7 $b),(Pct $r30 $b),(Pct $r90 $b))
}
W ("{0,-14} {1,8} {2} {3} {4} {5}" -f 'TOTAL',$allB,(Pct $a1 $allB),(Pct $a7 $allB),(Pct $a30 $allB),(Pct $a90 $allB))
W ""

# tempo entre 01 e 02 de quem completou os dois
$gap = [ordered]@{'<1min'=0;'1-5min'=0;'5-30min'=0;'30min-2h'=0;'>2h_mesmo_dia'=0;'outro_dia'=0}
$g=0
foreach ($v in $PDB.Values) {
    if ($v.d01 -gt 0 -and $v.d02 -gt 0 -and $v.d02 -ge $v.d01) {
        $m = ($v.d02 - $v.d01)/60000.0; $g++
        if     ($m -lt 1)    { $gap['<1min']++ }
        elseif ($m -lt 5)    { $gap['1-5min']++ }
        elseif ($m -lt 30)   { $gap['5-30min']++ }
        elseif ($m -lt 120)  { $gap['30min-2h']++ }
        elseif ($m -lt 1440) { $gap['>2h_mesmo_dia']++ }
        else                 { $gap['outro_dia']++ }
    }
}
W "--- TEMPO ENTRE CONCLUIR 01 E 02 (quem passou) ---"
foreach ($k in $gap.Keys) { W ("{0,-16} {1,7} {2}" -f $k,$gap[$k],(Pct $gap[$k] $g)) }
W ""

# cohort por mes de entrada no tutorial
$coh = @{}
foreach ($v in $PDB.Values) {
    if ($v.firstAct -le 0) { continue }
    $k = [DateTimeOffset]::FromUnixTimeMilliseconds($v.firstAct).ToLocalTime().ToString('yyyy-MM')
    if (-not $coh.ContainsKey($k)) { $coh[$k] = @(0,0,0,0) }  # base, done01, done02, done33
    $coh[$k][0]++
    if ($v.done.Contains('01tutorial')) { $coh[$k][1]++ }
    if ($v.done.Contains('02tutorial')) { $coh[$k][2]++ }
    if ($v.done.Contains('33tutorial')) { $coh[$k][3]++ }
}
W "--- COHORT POR MES DE PRIMEIRA ATIVIDADE ---"
W ("{0,-9} {1,7} {2,7} {3,7} {4,7} {5,8}" -f 'mes','base','c01','c02','c33','02/01')
foreach ($k in ($coh.Keys | Sort-Object)) {
    $r = $coh[$k]
    W ("{0,-9} {1,7} {2,7} {3,7} {4,7} {5}" -f $k,$r[0],$r[1],$r[2],$r[3],(Pct $r[2] $r[1]))
}

[System.IO.File]::WriteAllText($OutFile, $out.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ""
Write-Host ("Saida: {0}" -f $OutFile) -ForegroundColor Green
