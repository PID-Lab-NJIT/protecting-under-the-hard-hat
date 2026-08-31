# Optimization Record

## Phase 0 — Baseline & measurement

### 0.1: Current config

Output:

```
== processResponse ==
{
    "Runtime": "nodejs24.x",
    "Memory": 128,
    "Timeout": 10,
    "Layers": [
        "arn:aws:lambda:us-east-2:819026194778:layer:processResponse-deps:14"
    ]
}
== getLocalResources ==
{
    "Runtime": "nodejs24.x",
    "Memory": 128,
    "Timeout": 3,
    "Layers": [
        "arn:aws:lambda:us-east-2:819026194778:layer:getLocalResources-deps:18"
    ]
}
== downloadFromDrive ==
{
    "Runtime": "nodejs26.x",
    "Memory": 128,
    "Timeout": 10,
    "Layers": [
        "arn:aws:lambda:us-east-2:819026194778:layer:downloadFromDrive-deps:5"
    ]
}
== generateCsv ==
{
    "Runtime": "nodejs24.x",
    "Memory": 128,
    "Timeout": 20,
    "Layers": [
        "arn:aws:lambda:us-east-2:819026194778:layer:generateCsv-deps:42"
    ]
}
== uploadToDrive ==
{
    "Runtime": "nodejs24.x",
    "Memory": 128,
    "Timeout": 60,
    "Layers": [
        "arn:aws:lambda:us-east-2:819026194778:layer:uploadToDrive-deps:14"
    ]
}
```

### 0.2: Last 20 durations

Output

```
REPORT RequestId: 108683d4-1566-4914-acf8-2a7825869838  Duration: 10441.42 ms   Billed Duration: 10442 ms       Memory Size: 128 MB     Max Memory Used: 112 MB
REPORT RequestId: 3144013c-2c91-436f-b23f-9272228917c1  Duration: 20000.00 ms   Billed Duration: 20000 ms       Memory Size: 128 MB     Max Memory Used: 112 MB        Status: timeout
REPORT RequestId: 2c96302b-70d6-4d9e-825d-0a9966295766  Duration: 9962.87 ms    Billed Duration: 9963 ms        Memory Size: 128 MB     Max Memory Used: 113 MB

REPORT RequestId: 57be87e8-ca0f-4231-b33c-b0630db0f928  Duration: 3813.96 ms    Billed Duration: 4171 ms        Memory Size: 128 MB     Max Memory Used: 107 MB        Init Duration: 356.74 ms

REPORT RequestId: 47e1855a-55fb-469b-aa1a-55a5ed9400bb  Duration: 3736.69 ms    Billed Duration: 4009 ms        Memory Size: 128 MB     Max Memory Used: 107 MB        Init Duration: 271.82 ms

REPORT RequestId: 36af9264-63d8-48ac-b7a2-a83d71a7934b  Duration: 7553.06 ms    Billed Duration: 7913 ms        Memory Size: 128 MB     Max Memory Used: 111 MB        Init Duration: 359.89 ms
```

Extracted durations (not including init):

```
10441.42
20000.00
9962.87
3813.96
3736.69
7553.06
```

**Min (not including errors)**: 3736.69
**Max**: 20,000.00
**Avg**: 9251.23

## Phase 1 — `generate_csv` concurrency (no architecture change)

### 1.5: Runtime after optimization

Output:

```
REPORT RequestId: 2a41935a-f5fa-4c5f-98ba-433a67d84931  Duration: 8551.66 ms    Billed Duration: 9003 ms        Memory Size: 128 MB        Max Memory Used: 111 MB Init Duration: 451.23 ms
REPORT RequestId: d3a1bf19-da90-448b-8d4e-d04648bacb8d  Duration: 4015.50 ms    Billed Duration: 4357 ms        Memory Size: 128 MB        Max Memory Used: 107 MB Init Duration: 340.92 ms
REPORT RequestId: c938674c-3459-4ddc-876d-137ba3c428c5  Duration: 2167.26 ms    Billed Duration: 2168 ms        Memory Size: 128 MB        Max Memory Used: 111 MB
REPORT RequestId: 476eef4c-4df1-4ba9-86d7-6b966027b6f0  Duration: 1343.95 ms    Billed Duration: 1344 ms        Memory Size: 128 MB        Max Memory Used: 112 MB
REPORT RequestId: 927739c9-b51a-4694-aadf-5e50dd547268  Duration: 1441.77 ms    Billed Duration: 1442 ms        Memory Size: 128 MB        Max Memory Used: 112 MB
REPORT RequestId: 0e50c5e5-403d-403b-821e-9635e58b4488  Duration: 1140.15 ms    Billed Duration: 1141 ms        Memory Size: 128 MB        Max Memory Used: 112 MB
```

Extracted durations (not including init):

```
8551.66
4015.50
2167.26
1343.95
1441.77
1140.15
```

**Min**: 1140.15
**Max**: 8551.66
**Avg**: 3110.05

**Average gain**: 0.6638230808 (66.38%)