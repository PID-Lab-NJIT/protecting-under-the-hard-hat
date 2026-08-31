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
REPORT RequestId: 2a266eed-05b1-4ae3-93de-bee628192cc5  Duration: 6348.12 ms    Billed Duration: 6734 ms        Memory Size: 128 MB     Max Memory Used: 109 MB Init Duration: 385.63 ms
        REPORT RequestId: f92d1557-3fbd-43b6-b5bb-842881431d4d  Duration: 5665.62 ms    Billed Duration: 6002 ms        Memory Size: 128 MB     Max Memory Used: 107 MB Init Duration: 335.57 ms
        REPORT RequestId: e968f370-adbd-485a-a01b-f0c7c381b805  Duration: 5475.95 ms    Billed Duration: 5774 ms        Memory Size: 128 MB     Max Memory Used: 108 MB Init Duration: 297.23 ms

REPORT RequestId: 33d7fa46-ab99-416a-ba28-dd9b42dce4bc  Duration: 6305.40 ms    Billed Duration: 6684 ms        Memory Size: 128 MB     Max Memory Used: 108 MB Init Duration: 377.78 ms

REPORT RequestId: f07679d0-c204-4a7b-bf0c-aa96eb632f29  Duration: 5635.15 ms    Billed Duration: 5925 ms        Memory Size: 128 MB     Max Memory Used: 107 MB Init Duration: 289.33 ms

REPORT RequestId: f6fbfccf-1a5c-47de-8f87-44e32d05986f  Duration: 5756.52 ms    Billed Duration: 6048 ms        Memory Size: 128 MB     Max Memory Used: 109 MB Init Duration: 290.71 ms

REPORT RequestId: 82fec0e9-81df-45b0-bd97-1efc609d4185  Duration: 5936.45 ms    Billed Duration: 6210 ms        Memory Size: 128 MB     Max Memory Used: 108 MB Init Duration: 272.80 ms

REPORT RequestId: ac348bcf-8ec4-4de3-84e5-1b40b19c06b0  Duration: 5646.15 ms    Billed Duration: 5959 ms        Memory Size: 128 MB     Max Memory Used: 109 MB Init Duration: 312.48 ms

REPORT RequestId: f0b33b6b-cee6-4a6c-8a17-83ac531c2bce  Duration: 5936.07 ms    Billed Duration: 6226 ms        Memory Size: 128 MB     Max Memory Used: 110 MB Init Duration: 289.66 ms

REPORT RequestId: 6e4c9355-8aa1-4ff5-8e14-7ec5a9abf6b3  Duration: 5615.71 ms    Billed Duration: 5897 ms        Memory Size: 128 MB     Max Memory Used: 108 MB Init Duration: 280.60 ms

REPORT RequestId: 2c8fdda8-0178-4507-a371-a2b3ec1c9429  Duration: 7577.90 ms    Billed Duration: 7896 ms        Memory Size: 128 MB     Max Memory Used: 114 MB Init Duration: 317.87 ms

REPORT RequestId: 71c8a532-3581-4da3-bfc4-e95d52658be0  Duration: 3734.56 ms    Billed Duration: 4025 ms        Memory Size: 128 MB     Max Memory Used: 107 MB Init Duration: 290.40 ms
        INIT_REPORT Init Duration: 148.12 ms    Phase: init     Status: error   Error Type: Runtime.ImportModuleError
        INIT_REPORT Init Duration: 109.22 ms    Phase: invoke   Status: error   Error Type: Runtime.ImportModuleError
        REPORT RequestId: 48722ed1-2b26-44aa-a15c-8daf61f24e56  Duration: 122.39 ms     Billed Duration: 123 ms Memory Size: 128 MB     Max Memory Used: 78 MB  Status: error   Error Type: Runtime.ImportModuleError
        INIT_REPORT Init Duration: 124.34 ms    Phase: init     Status: error   Error Type: Runtime.Unknown
        INIT_REPORT Init Duration: 92.27 ms     Phase: invoke   Status: error   Error Type: Runtime.Unknown
        REPORT RequestId: a80bb1e5-3de5-4905-b05e-d126b483f079  Duration: 104.60 ms     Billed Duration: 105 ms Memory Size: 128 MB     Max Memory Used: 80 MB  Status: error   Error Type: Runtime.Unknown
        REPORT RequestId: d9fa7d10-e3fd-4472-80aa-87b6e465322a  Duration: 3527.09 ms    Billed Duration: 3879 ms        Memory Size: 128 MB     Max Memory Used: 106 MB Init Duration: 351.45 ms
        REPORT RequestId: 409f54c1-b3e8-448b-a997-3c5b70824f79  Duration: 1816.39 ms    Billed Duration: 1817 ms        Memory Size: 128 MB     Max Memory Used: 106 MB
```

Extracted durations (not including init):

```
6348.12
5665.62
5475.95
6305.40
5635.15
5756.52
5936.45
5646.15
5936.07
5615.71
7577.90
3734.56
122.39
104.60
3527.09
1816.39
```

Min (not including errors): **1816.39**
Max: **7577.90**
Avg: **75,204.07**