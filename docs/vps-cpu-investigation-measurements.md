# VPS CPU investigation: available measurements

These are the available summaries from the November 12–13, 2026 investigation, not raw time-series samples or binary pprof profiles. The original binary profiles were deleted after analysis; individual one-second A/B samples were not retained in the available session records. Values below are preserved as recorded and are not reconstructed.

## Five-device CPU quota trial

The two phases were consecutive 45-second observations of a real five-device call, sampled from cgroup counters. The 1.0-core phase ran approximately 23:13:58–23:14:43 UTC on November 12, 2026. The original 0.75-core limit was restored after the trial. CPU pressure values are averages of the rolling `avg10` values sampled during each phase, not independently measured instantaneous percentages.

| Container limit | Average CPU | Maximum CPU | Average system CPU | Throttle events | Throttled time | Mean CPU PSI `avg10` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.75 core | 56.92% | 74.46% | 41.34% | 84 | 800.8 ms | 38.22% |
| 1.0 core | 57.91% | 80.35% | 41.65% | 0 | 0 ms | 37.14% |

The phases were not randomized, and the user could not tell whether call quality improved. Eliminating quota throttling in this short trial does not establish a quality improvement or eliminate other CPU pressure.

Separate earlier observations during the call included 61.02% Docker CPU, eight two-second CPU samples ranging roughly 43–67%, and cgroup CPU pressure reported as `some avg60=45.76` and `full avg60=35.93`. Individual values and exact timing for those eight samples are unavailable.

## Live CPU profile: 15-second capture

Capture began at approximately 23:17:34 UTC on November 12, 2026. Duration was 15 seconds; total sampled CPU was 7.76 seconds (51.73% of one CPU). Profile build ID: `298b74dcd0a04375d5b5c8c6577b44e09613fad5`.

| Function | Flat CPU | Flat % | Cumulative CPU | Cumulative % |
| --- | ---: | ---: | ---: | ---: |
| `internal/runtime/syscall/linux.Syscall6` | 4.63 s | 59.66% | 4.63 s | 59.66% |
| `SlowMeet/internal/media.relayRTCP` | 0.03 s | 0.39% | 5.77 s | 74.36% |
| `github.com/pion/webrtc/v4/internal/mux.(*Endpoint).Write` | 0.05 s | 0.64% | 4.67 s | 60.18% |
| `internal/poll.(*FD).WriteToInet4` | 0.04 s | 0.52% | 4.42 s | 56.96% |
| `github.com/pion/webrtc/v4.(*RTPSender).Read` | 0.05 s | 0.64% | 0.63 s | 8.12% |
| `github.com/pion/rtcp.(*TransportLayerCC).Unmarshal` | 0.06 s | 0.77% | 0.51 s | 6.57% |
| `github.com/pion/interceptor.Attributes.GetRTCPPackets` | 0.03 s | 0.39% | 0.41 s | 5.28% |

## Live CPU profile: 10-second capture

Capture began at approximately 23:18:23 UTC on November 12, 2026. Duration was 10 seconds; total sampled CPU was 5.73 seconds (57.28% of one CPU). This is a separate observation of the same deployed build.

| Function | Flat CPU | Flat % | Cumulative CPU | Cumulative % |
| --- | ---: | ---: | ---: | ---: |
| `SlowMeet/internal/media.relayRTCP` | 0 s | 0% | 4.24 s | 74.00% |
| `internal/runtime/syscall/linux.Syscall6` | 3.66 s | 63.87% | 3.66 s | 63.87% |
| `github.com/pion/webrtc/v4.(*PeerConnection).WriteRTCP` | 0 s | 0% | 3.52 s | 61.43% |
| `github.com/pion/webrtc/v4/internal/mux.(*Endpoint).Write` | 0.03 s | 0.52% | 3.44 s | 60.03% |
| `github.com/pion/srtp/v3.(*SessionSRTCP).write` | 0.02 s | 0.35% | 3.42 s | 59.69% |
| `net.(*UDPConn).WriteToUDPAddrPort` | 0 s | 0% | 3.33 s | 58.12% |
| `syscall.sendto` | 0 s | 0% | 3.29 s | 57.42% |
| `github.com/pion/webrtc/v4.(*RTPSender).ReadRTCP` | 0 s | 0% | 0.70 s | 12.22% |

Within `relayRTCP`, the 10-second profile attributed 700 ms cumulative CPU to `sender.ReadRTCP()` and 3.54 s cumulative CPU to the `source.WriteRTCP(routeRTCPFeedback(...))` line. Cumulative rows overlap and must not be added together. CPU profiles alone do not establish feedback packet counts, packet types responsible for writes, or the root cause of time in the kernel.
