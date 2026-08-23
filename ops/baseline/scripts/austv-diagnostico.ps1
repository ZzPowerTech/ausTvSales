<#
  AusTV - Diagnostico de retencao (leitura offline do clone)
  Nao modifica nada. So le.

  COMO RODAR:
    1. Salve este arquivo em D:\AUSTV\austv-diagnostico.ps1
    2. Abra o PowerShell e rode:
         powershell -ExecutionPolicy Bypass -File D:\AUSTV\austv-diagnostico.ps1
    3. Cole aqui o conteudo de austv-diagnostico-saida.txt
#>

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# CAMINHOS
# ---------------------------------------------------------------------------
$Base     = 'D:\AUSTV\clone_survival'
$UserData = Join-Path $Base 'Essentials\userdata'
$QuestsPD = Join-Path $Base 'Quests\playerdata'
$TutDir   = Join-Path $Base 'Quests\quests\tutorial'

# Opcional: pasta stats do mundo (nao existe no clone). Se voce tiver acesso
# ao servidor, aponte aqui para liberar o BLOCO 3 (playtime real).
$StatsDir = ''   # ex: 'D:\AUSTV\servidor\world\stats'

$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$OutFile = Join-Path $root 'austv-diagnostico-saida.txt'

$inv = [System.Globalization.CultureInfo]::InvariantCulture
$out = New-Object System.Text.StringBuilder
function W($t) { [void]$out.AppendLine([string]$t); Write-Host $t }
function Pct($a,$b) { if ($b -le 0) { return '  0.0%' }; '{0,6:N1}%' -f (100.0*$a/$b) }

W ("AusTV diagnostico | {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'))
W ""

# ===========================================================================
# BLOCO 1 - ESSENTIALS USERDATA
# ===========================================================================
W "=========== BLOCO 1: ESSENTIALS USERDATA ==========="
$sw = [Diagnostics.Stopwatch]::StartNew()

$cap     = 120000
$aLogin  = New-Object 'int64[]'  $cap
$aLogout = New-Object 'int64[]'  $cap
$aPlat   = New-Object 'byte[]'   $cap    # 0 outro 1 premium 2 offline 3 bedrock
$aFlags  = New-Object 'byte[]'   $cap    # bit0 home, bit1 kit prot
$aMoney  = New-Object 'double[]' $cap
$n = 0

foreach ($f in [System.IO.Directory]::EnumerateFiles($UserData, '*.yml')) {

    $login = 0L; $logout = 0L; $homes = 0; $kitProt = 0; $money = -1.0
    $inTs = $false; $inHomes = $false; $inKits = $false

    $rd = [System.IO.File]::OpenText($f)
    try {
        while ($null -ne ($line = $rd.ReadLine())) {
            if ($line.Length -eq 0) { continue }

            if ($line[0] -ne ' ') {
                $inTs    = $line.StartsWith('timestamps:')
                $inHomes = $line.StartsWith('homes:')
                $inKits  = $false
                if ($line.StartsWith('money:')) {
                    $v = $line.Substring(6).Trim().Trim("'").Trim('"')
                    $tmp = 0.0
                    if ([double]::TryParse($v, [System.Globalization.NumberStyles]::Float, $inv, [ref]$tmp)) { $money = $tmp }
                }
                continue
            }

            if ($inTs) {
                if     ($line.StartsWith('  login: '))  { $login  = [int64]$line.Substring(9).Trim();  $inKits = $false }
                elseif ($line.StartsWith('  logout: ')) { $logout = [int64]$line.Substring(10).Trim(); $inKits = $false }
                elseif ($line.StartsWith('  kits:'))    { $inKits = $true }
                elseif ($inKits -and $line.StartsWith('    prot:')) { $kitProt = 1 }
                elseif ($line[2] -ne ' ')               { $inKits = $false }
            }
            elseif ($inHomes -and $line[2] -ne ' ') { $homes++ }
        }
    } finally { $rd.Dispose() }

    $name = [System.IO.Path]::GetFileNameWithoutExtension($f)
    $p = 0
    if     ($name.StartsWith('00000000-0000-0000-0009-')) { $p = 3 }
    elseif ($name.Length -ge 15 -and $name[14] -eq '3')   { $p = 2 }
    elseif ($name.Length -ge 15 -and $name[14] -eq '4')   { $p = 1 }

    $fl = 0
    if ($homes   -gt 0) { $fl = $fl -bor 1 }
    if ($kitProt -eq 1) { $fl = $fl -bor 2 }

    $aLogin[$n] = $login; $aLogout[$n] = $logout
    $aPlat[$n]  = $p;     $aFlags[$n]  = $fl; $aMoney[$n] = $money
    $n++
    if ($n % 5000 -eq 0) { Write-Host ("  ... {0}" -f $n) -ForegroundColor DarkGray }
    if ($n -ge $cap) { W "AVISO: capacidade estourada"; break }
}
$sw.Stop()

W ("arquivos_userdata: {0}   ({1:N0}s)" -f $n, $sw.Elapsed.TotalSeconds)

$maxLogin = 0L
for ($i=0; $i -lt $n; $i++) { if ($aLogin[$i] -gt $maxLogin) { $maxLogin = $aLogin[$i] } }
$refDt = [DateTimeOffset]::FromUnixTimeMilliseconds($maxLogin).ToLocalTime().LocalDateTime
W ("login_mais_recente: {0:yyyy-MM-dd HH:mm}" -f $refDt)
W ("hoje:               {0:yyyy-MM-dd HH:mm}   (defasagem do snapshot: {1:N1} dias)" -f (Get-Date), ((Get-Date)-$refDt).TotalDays)
W ""

$bk   = [ordered]@{'<=1d'=0;'<=7d'=0;'<=30d'=0;'<=90d'=0;'<=365d'=0;'>365d'=0;'sem_login'=0}
$sess = [ordered]@{'<1min'=0;'1-5min'=0;'5-30min'=0;'30-120min'=0;'2-10h'=0;'>10h'=0;'sem_dado'=0}
$plat = [ordered]@{'java_premium'=0;'java_offline'=0;'bedrock'=0;'outro'=0}
$pn   = @('outro','java_premium','java_offline','bedrock')
$comHome=0; $comKit=0; $mZero=0; $mLidos=0; $ativos30=0

# funil cruzado: sessao curta x chegou ao gate
$curtoSemHome = 0

for ($i=0; $i -lt $n; $i++) {
    $lg = $aLogin[$i]; $lo = $aLogout[$i]
    if ($lg -le 0) { $bk['sem_login']++ }
    else {
        $d = ($maxLogin - $lg) / 86400000.0
        if     ($d -le 1)   { $bk['<=1d']++ }
        elseif ($d -le 7)   { $bk['<=7d']++ }
        elseif ($d -le 30)  { $bk['<=30d']++ }
        elseif ($d -le 90)  { $bk['<=90d']++ }
        elseif ($d -le 365) { $bk['<=365d']++ }
        else                { $bk['>365d']++ }
        if ($d -le 30) { $ativos30++ }
    }

    $curta = $false
    if ($lg -le 0 -or $lo -le 0 -or $lo -lt $lg) { $sess['sem_dado']++ }
    else {
        $m = ($lo - $lg) / 60000.0
        if     ($m -lt 1)   { $sess['<1min']++;     $curta = $true }
        elseif ($m -lt 5)   { $sess['1-5min']++;    $curta = $true }
        elseif ($m -lt 30)  { $sess['5-30min']++ }
        elseif ($m -lt 120) { $sess['30-120min']++ }
        elseif ($m -lt 600) { $sess['2-10h']++ }
        else                { $sess['>10h']++ }
    }

    $plat[$pn[$aPlat[$i]]]++
    if (($aFlags[$i] -band 1) -ne 0) { $comHome++ } elseif ($curta) { $curtoSemHome++ }
    if (($aFlags[$i] -band 2) -ne 0) { $comKit++ }
    if ($aMoney[$i] -ge 0) { $mLidos++; if ($aMoney[$i] -le 0) { $mZero++ } }
}

W "--- CHURN: ultimo login (base = todos) ---"
foreach ($k in $bk.Keys)   { W ("{0,-10} {1,7}  {2}" -f $k, $bk[$k],   (Pct $bk[$k] $n)) }
W ""
W "--- DURACAO DA ULTIMA SESSAO (logout - login) ---"
foreach ($k in $sess.Keys) { W ("{0,-10} {1,7}  {2}" -f $k, $sess[$k], (Pct $sess[$k] $n)) }
W ""
W "--- TIPO DE CONTA ---"
foreach ($k in $plat.Keys) { W ("{0,-14} {1,7}  {2}" -f $k, $plat[$k], (Pct $plat[$k] $n)) }
W ""
W "--- GATES DO TUTORIAL VISIVEIS NO ESSENTIALS ---"
W ("total_jogadores        {0,7}" -f $n)
W ("recebeu_kit_prot       {0,7}  {1}   <- recompensa do 02tutorial" -f $comKit,  (Pct $comKit $n))
W ("tem_pelo_menos_1_home  {0,7}  {1}   <- gate do 05tutorial (/casacriar)" -f $comHome, (Pct $comHome $n))
W ("sessao_curta_sem_home  {0,7}  {1}" -f $curtoSemHome, (Pct $curtoSemHome $n))
W ("saldo_zero             {0,7}  de {1} com money lido" -f $mZero, $mLidos)
W ("ativos_ultimos_30d     {0,7}  {1}" -f $ativos30, (Pct $ativos30 $n))
W ""

$byMonth = @{}
for ($i=0; $i -lt $n; $i++) {
    if ($aLogin[$i] -gt 0) {
        $k = [DateTimeOffset]::FromUnixTimeMilliseconds($aLogin[$i]).ToLocalTime().ToString('yyyy-MM')
        if ($byMonth.ContainsKey($k)) { $byMonth[$k]++ } else { $byMonth[$k] = 1 }
    }
}
W "--- ULTIMO LOGIN POR MES (quando cada leva desistiu) ---"
foreach ($k in ($byMonth.Keys | Sort-Object)) { W ("{0}  {1,6}" -f $k, $byMonth[$k]) }
W ""

# ===========================================================================
# BLOCO 2 - FUNIL DO TUTORIAL (Quests)
# ===========================================================================
W "=========== BLOCO 2: FUNIL DO TUTORIAL ==========="
$sw2 = [Diagnostics.Stopwatch]::StartNew()

$idSet = New-Object 'System.Collections.Generic.HashSet[string]'
$ids = @()
foreach ($qf in [System.IO.Directory]::EnumerateFiles($TutDir, '*.yml')) {
    $id = [System.IO.Path]::GetFileNameWithoutExtension($qf)
    $ids += $id; [void]$idSet.Add($id)
}
$ordered = $ids | Sort-Object @{E={[int]([regex]::Match($_,'^\d+')).Value}}, @{E={$_}}
W ("quests_no_tutorial: {0}" -f $ids.Count)

$started = @{}; $done = @{}
foreach ($id in $ids) { $started[$id] = 0; $done[$id] = 0 }

$pdTotal=0; $pdVazio=0; $pdSemTut=0; $pdComTut=0
$maxStepHist = @{}
$maiorArq=''; $maiorTam=0

foreach ($f in [System.IO.Directory]::EnumerateFiles($QuestsPD, '*.yml')) {
    $pdTotal++
    $len = (New-Object System.IO.FileInfo $f).Length
    if ($len -eq 0) { $pdVazio++; continue }
    if ($len -gt $maiorTam) { $maiorTam = $len; $maiorArq = $f }

    $curId = $null; $curIndent = -1; $curDone = $false
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $doneHere = New-Object 'System.Collections.Generic.HashSet[string]'

    foreach ($line in [System.IO.File]::ReadLines($f)) {
        if ($line.Trim().Length -eq 0) { continue }
        $ind = 0; while ($ind -lt $line.Length -and $line[$ind] -eq ' ') { $ind++ }
        $t = $line.Substring($ind)

        if ($curId -ne $null -and $ind -le $curIndent) {
            if ($curDone) { [void]$doneHere.Add($curId) }
            $curId = $null; $curDone = $false
        }

        $ci = $t.IndexOf(':')
        if ($ci -gt 0) {
            $key = $t.Substring(0, $ci).Trim('"').Trim("'")
            $val = $t.Substring($ci+1).Trim()
            if ($idSet.Contains($key)) {
                if ($curId -ne $null -and $curDone) { [void]$doneHere.Add($curId) }
                $curId = $key; $curIndent = $ind; $curDone = $false
                [void]$seen.Add($key)
            }
            elseif ($curId -ne $null -and $key -eq 'completed' -and $val -eq 'true') { $curDone = $true }
        }
    }
    if ($curId -ne $null -and $curDone) { [void]$doneHere.Add($curId) }

    if ($seen.Count -eq 0) { $pdSemTut++; continue }
    $pdComTut++
    foreach ($s in $seen)     { $started[$s]++ }
    foreach ($s in $doneHere) { $done[$s]++ }

    $mx = 0
    foreach ($s in $doneHere) {
        $mm = [regex]::Match($s,'^\d+'); if ($mm.Success) { $v = [int]$mm.Value; if ($v -gt $mx) { $mx = $v } }
    }
    if ($maxStepHist.ContainsKey($mx)) { $maxStepHist[$mx]++ } else { $maxStepHist[$mx] = 1 }

    if ($pdTotal % 2000 -eq 0) { Write-Host ("  ... {0}" -f $pdTotal) -ForegroundColor DarkGray }
}
$sw2.Stop()

W ("playerdata_total:     {0}   ({1:N0}s)" -f $pdTotal, $sw2.Elapsed.TotalSeconds)
W ("playerdata_vazio_0kb: {0}  {1}   <- entrou e nunca tocou em quest nenhuma" -f $pdVazio, (Pct $pdVazio $pdTotal))
W ("playerdata_sem_tutorial: {0}  {1}" -f $pdSemTut, (Pct $pdSemTut $pdTotal))
W ("playerdata_com_tutorial: {0}  {1}" -f $pdComTut, (Pct $pdComTut $pdTotal))
W ""
W "--- FUNIL POR QUEST (base = playerdata_total) ---"
W ("{0,-16} {1,8} {2,8} {3}" -f 'quest','tocou','concluiu','%concl')
foreach ($id in $ordered) { W ("{0,-16} {1,8} {2,8} {3}" -f $id, $started[$id], $done[$id], (Pct $done[$id] $pdTotal)) }
W ""
W "--- ATE ONDE CHEGOU (maior passo concluido) ---"
foreach ($k in ($maxStepHist.Keys | Sort-Object)) { W ("passo {0,-3} {1,7}  {2}" -f $k, $maxStepHist[$k], (Pct $maxStepHist[$k] $pdTotal)) }
W ""
W ("--- AMOSTRA: maior playerdata ({0} bytes) ---" -f $maiorTam)
if ($maiorArq -ne '') { foreach ($l in (Get-Content -LiteralPath $maiorArq -TotalCount 45)) { W $l } }
W ""

# ===========================================================================
# BLOCO 3 - PLAYTIME (world/stats) - opcional
# ===========================================================================
W "=========== BLOCO 3: PLAYTIME (world/stats) ==========="
if ([string]::IsNullOrWhiteSpace($StatsDir) -or -not (Test-Path $StatsDir)) {
    W "PULADO: \$StatsDir nao configurado ou inexistente."
    W "O clone so tem a pasta plugins - nao ha world\stats aqui."
} else {
    $pt = [ordered]@{'<5min'=0;'5-30min'=0;'30-120min'=0;'2-10h'=0;'>10h'=0;'sem_dado'=0}
    $c = 0
    foreach ($f in [System.IO.Directory]::EnumerateFiles($StatsDir, '*.json')) {
        $c++
        $txt = [System.IO.File]::ReadAllText($f)
        $m = [regex]::Match($txt, '"minecraft:(play_time|play_one_minute)"\s*:\s*(\d+)')
        if (-not $m.Success) { $pt['sem_dado']++; continue }
        $min = ([double]$m.Groups[2].Value) / 20.0 / 60.0
        if     ($min -lt 5)   { $pt['<5min']++ }
        elseif ($min -lt 30)  { $pt['5-30min']++ }
        elseif ($min -lt 120) { $pt['30-120min']++ }
        elseif ($min -lt 600) { $pt['2-10h']++ }
        else                  { $pt['>10h']++ }
    }
    W ("arquivos_stats: {0}" -f $c)
    foreach ($k in $pt.Keys) { W ("{0,-10} {1,7}  {2}" -f $k, $pt[$k], (Pct $pt[$k] $c)) }
}

[System.IO.File]::WriteAllText($OutFile, $out.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ""
Write-Host ("Saida salva em: {0}" -f $OutFile) -ForegroundColor Green
