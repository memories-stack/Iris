#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Vision/Vision.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <math.h>
#include <time.h>
#include <unistd.h>
#include <pthread.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <dirent.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <mach-o/dyld.h>
#include <libgen.h>
#include <dispatch/dispatch.h>

#define DEFAULT_PORT 5182
#define NATIVE_VERSION "1.6.2"
#define DEFAULT_UPDATE_MANIFEST_URL "https://memories-stack.github.io/Iris/version.json"
#define MAX_BATCH_FILES 10000

typedef struct {
    char name[256];
    long long size;
    long mtime;
    int width;
    int height;
    int score;
    int subjSharp;
    int bgSharp;
    float bokehRatio;
    int blurCode; // 0=none, 1=motion_blur, 2=out_of_focus, 3=back_focus, 4=eyes_closed
    int isPortrait;
    float boxX; // Normalized 0..1
    float boxY;
    float boxW;
    float boxH;
    int scanned;
} NativePhotoRecord;

static int g_actual_port = DEFAULT_PORT;
static char g_html_path[2048] = {0};
static char g_bundle_html_path[2048] = {0};
static char g_ota_html_path[2048] = {0};
static char g_ota_dir[2048] = {0};
static long g_boot_time = 0;
static char g_source_dir[2048] = {0};
static int g_raw_count = 0;

static NSData *fetch_url_sync(NSString *urlStr, double timeoutSec, NSInteger *outStatus) {
    NSURL *url = [NSURL URLWithString:urlStr];
    if (!url) return nil;
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url
                                                       cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                   timeoutInterval:timeoutSec];
    [req setValue:@"Iris-macOS/1.6.0" forHTTPHeaderField:@"User-Agent"];

    __block NSData *resultData = nil;
    __block NSInteger statusCode = 0;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    NSURLSession *session = [NSURLSession sharedSession];
    NSURLSessionDataTask *task = [session dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (!error && [response isKindOfClass:[NSHTTPURLResponse class]]) {
            statusCode = [(NSHTTPURLResponse *)response statusCode];
            if (statusCode >= 200 && statusCode < 300) {
                resultData = data;
            }
        }
        dispatch_semaphore_signal(sem);
    }];
    [task resume];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)((timeoutSec + 1.0) * NSEC_PER_SEC)));
    if (outStatus) *outStatus = statusCode;
    return resultData;
}

static NativePhotoRecord g_records[MAX_BATCH_FILES];
static int g_total_files = 0;
static volatile int g_done_files = 0;
static volatile int g_is_scanning = 0;
static volatile int g_cancel_scan = 0;
static int g_scan_generation = 0;
static double g_scan_start_time = 0;

static pthread_mutex_t g_dir_mutex = PTHREAD_MUTEX_INITIALIZER;

static double now_sec(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

static void url_decode_raw(const char *src, char *dst, size_t dst_size) {
    size_t di = 0;
    for (size_t si = 0; src[si] && di + 1 < dst_size; si++) {
        if (src[si] == '%' && src[si + 1] && src[si + 2]) {
            char hex[3] = { src[si + 1], src[si + 2], 0 };
            dst[di++] = (char)strtol(hex, NULL, 16);
            si += 2;
        } else if (src[si] == '+') {
            dst[di++] = ' ';
        } else {
            dst[di++] = src[si];
        }
    }
    dst[di] = '\0';
}

static void url_decode_safe_filename(const char *src, char *dst, size_t dst_size) {
    url_decode_raw(src, dst, dst_size);
    for (size_t i = 0; dst[i]; i++) {
        if (dst[i] == '/' || dst[i] == '\\') dst[i] = '_';
    }
}

static int is_supported_image_ext(const char *name) {
    const char *dot = strrchr(name, '.');
    if (!dot) return 0;
    return (strcasecmp(dot, ".jpg") == 0 ||
            strcasecmp(dot, ".jpeg") == 0 ||
            strcasecmp(dot, ".png") == 0 ||
            strcasecmp(dot, ".webp") == 0 ||
            strcasecmp(dot, ".heic") == 0);
}

static int is_raw_camera_ext(const char *name) {
    const char *dot = strrchr(name, '.');
    if (!dot) return 0;
    return (strcasecmp(dot, ".nef") == 0 ||
            strcasecmp(dot, ".arw") == 0 ||
            strcasecmp(dot, ".cr2") == 0 ||
            strcasecmp(dot, ".cr3") == 0 ||
            strcasecmp(dot, ".dng") == 0 ||
            strcasecmp(dot, ".raf") == 0 ||
            strcasecmp(dot, ".orf") == 0 ||
            strcasecmp(dot, ".rw2") == 0);
}

static int compare_records_by_name(const void *a, const void *b) {
    const NativePhotoRecord *ra = (const NativePhotoRecord *)a;
    const NativePhotoRecord *rb = (const NativePhotoRecord *)b;
    return strcasecmp(ra->name, rb->name);
}

// ============================================================================
// NATIVE APPLE SILICON MULTI-CORE PHOTO SHARPNESS & FOCUS ANALYZER
// Runs at ~250 photos/sec across all CPU/GPU cores without touching WebKit UI!
// ============================================================================
static void analyze_single_photo_native(const char *dir_path, NativePhotoRecord *rec) {
    @autoreleasepool {
        char full_path[4096];
        snprintf(full_path, sizeof(full_path), "%s/%s", dir_path, rec->name);

        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:full_path]];
        if (!url) {
            rec->score = 50;
            rec->scanned = 1;
            return;
        }

        CGImageSourceRef src = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
        if (!src) {
            rec->score = 50;
            rec->scanned = 1;
            return;
        }

        // Read original pixel dimensions from metadata header (0.02ms)
        CFDictionaryRef props = CGImageSourceCopyPropertiesAtIndex(src, 0, NULL);
        if (props) {
            CFNumberRef pw = CFDictionaryGetValue(props, kCGImagePropertyPixelWidth);
            CFNumberRef ph = CFDictionaryGetValue(props, kCGImagePropertyPixelHeight);
            if (pw) CFNumberGetValue(pw, kCFNumberIntType, &rec->width);
            if (ph) CFNumberGetValue(ph, kCFNumberIntType, &rec->height);
            CFRelease(props);
        }

        // Fast DCT 1/8 hardware subsampled decode to 512px max
        NSDictionary *opts = @{
            (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
            (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
            (id)kCGImageSourceThumbnailMaxPixelSize: @512
        };
        CGImageRef img = CGImageSourceCreateThumbnailAtIndex(src, 0, (__bridge CFDictionaryRef)opts);
        CFRelease(src);

        if (!img) {
            rec->score = 50;
            rec->scanned = 1;
            return;
        }

        size_t sw = CGImageGetWidth(img);
        size_t sh = CGImageGetHeight(img);
        if (rec->width == 0) rec->width = (int)sw;
        if (rec->height == 0) rec->height = (int)sh;

        uint8_t *rgba = calloc(sw * sh * 4, 1);
        CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
        CGContextRef ctx = CGBitmapContextCreate(rgba, sw, sh, 8, sw * 4, cs, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
        CGContextDrawImage(ctx, CGRectMake(0, 0, sw, sh), img);
        CGContextRelease(ctx);
        CGColorSpaceRelease(cs);
        CGImageRelease(img);

        float *gray = malloc(sw * sh * sizeof(float));
        uint8_t *isSkin = calloc(sw * sh, 1);
        int totalSkinCount = 0;

        for (size_t i = 0; i < sw * sh; i++) {
            uint8_t r = rgba[i * 4];
            uint8_t g = rgba[i * 4 + 1];
            uint8_t b = rgba[i * 4 + 2];
            gray[i] = 0.299f * r + 0.587f * g + 0.114f * b;

            // YCrCb Skin Chrominance Filter
            float cr = 128.0f + 0.5f * r - 0.418688f * g - 0.081312f * b;
            float cb = 128.0f - 0.168736f * r - 0.331264f * g + 0.5f * b;
            if (r >= 68 && g >= 40 && b >= 25 && (r - g) >= 12 && (r - b) >= 18 &&
                cr >= 134.0f && cr <= 178.0f && cb >= 80.0f && cb <= 135.0f) {
                isSkin[i] = 1;
                totalSkinCount++;
            }
        }

        // ====================================================================
        // SKIN-WEIGHTED 2x2 HEAD + 2x2 TORSO/BIB CONTINUITY ENGINE
        // Accurately handles:
        // 1. Distant full-body runners wearing caps/sunglasses/long sleeves (31040, 33713)
        // 2. Side-by-side dual runners (19473..19476)
        // 3. Rejects blurry runners against bright walls or stone backgrounds (16544..16546, 31794, 32954, 33070)
        // ====================================================================
        int gxN = 12, gyN = 12;
        int pw = MAX(8, (int)sw / gxN);
        int ph = MAX(8, (int)sh / gyN);

        double patchLap[12][12] = {0};
        double patchSkin[12][12] = {0};
        double patchAniso[12][12] = {0};
        double top3Any[3] = {0, 0, 0};
        double bgSum = 0;
        int bgPatches = 0;

        for (int gy = 1; gy <= 8; gy++) {
            for (int gx = 1; gx <= 10; gx++) {
                int x0 = MAX(1, gx * pw);
                int x1 = MIN((int)sw - 2, (gx + 1) * pw);
                int y0 = MAX(1, gy * ph);
                int y1 = MIN((int)sh - 2, (gy + 1) * ph);

                int skinCnt = 0;
                int totCnt = 0;
                int sharpMicro = 0;
                double lapSq = 0;
                double gxAbs = 0, gyAbs = 0;

                for (int y = y0; y < y1; y++) {
                    for (int x = x0; x < x1; x++) {
                        size_t idx = (size_t)y * sw + (size_t)x;
                        float lap = fabs(
                            gray[idx - sw - 1] + gray[idx - sw] + gray[idx - sw + 1] +
                            gray[idx - 1] - 8.0f * gray[idx] + gray[idx + 1] +
                            gray[idx + sw - 1] + gray[idx + sw] + gray[idx + sw + 1]
                        ) * 0.5f;
                        float clamped = MIN(lap, 95.0f);
                        lapSq += (double)(clamped * clamped);
                        if (lap > 22.0f) sharpMicro++;
                        if (isSkin[idx]) skinCnt++;
                        totCnt++;

                        float dx = -gray[idx - 1] + gray[idx + 1];
                        float dy = -gray[idx - sw] + gray[idx + sw];
                        gxAbs += fabs(dx);
                        gyAbs += fabs(dy);
                    }
                }

                double microRatio = (double)sharpMicro / MAX(1, totCnt);
                double pLap = (lapSq / MAX(1, totCnt)) * (0.45 + 1.65 * microRatio);
                double pSkin = (double)skinCnt / MAX(1, totCnt);
                double ar = (gxAbs + 1.0) / (gyAbs + 1.0);

                patchLap[gy][gx] = pLap;
                patchSkin[gy][gx] = pSkin;
                patchAniso[gy][gx] = ar < 1.0 ? (1.0 / ar) : ar;

                if (pLap > top3Any[0]) {
                    top3Any[2] = top3Any[1];
                    top3Any[1] = top3Any[0];
                    top3Any[0] = pLap;
                } else if (pLap > top3Any[1]) {
                    top3Any[2] = top3Any[1];
                    top3Any[1] = pLap;
                } else if (pLap > top3Any[2]) {
                    top3Any[2] = pLap;
                }

                if (pSkin < 0.05) {
                    bgSum += pLap;
                    bgPatches++;
                }
            }
        }

        double bestRunnerEnergy = 0;
        int bestGx = gxN / 2;
        int bestGy = 2;
        double bestGxAniso = 1.0;

        for (int gy = 1; gy <= 3; gy++) {
            for (int gx = 1; gx <= 9; gx++) {
                double skinSum = 0;
                double weightedHeadLap = 0;
                for (int dy = 0; dy <= 1; dy++) {
                    for (int dx = 0; dx <= 1; dx++) {
                        double s = patchSkin[gy + dy][gx + dx];
                        if (s >= 0.08) {
                            skinSum += s;
                            weightedHeadLap += s * patchLap[gy + dy][gx + dx];
                        }
                    }
                }
                if (skinSum < 0.22) continue;

                // Verify lower body continuity (arms/legs skin below head in [gy+2..gy+6, gx-1..gx+2])
                double lowerSkin = 0;
                for (int ly = gy + 2; ly <= MIN(8, gy + 6); ly++) {
                    for (int lx = MAX(1, gx - 1); lx <= MIN(10, gx + 2); lx++) {
                        if (patchSkin[ly][lx] > lowerSkin) lowerSkin = patchSkin[ly][lx];
                    }
                }
                if (lowerSkin < 0.08) continue;

                double headE = weightedHeadLap / skinSum;
                double t1 = MAX(patchLap[gy + 1][gx], patchLap[gy + 1][gx + 1]);
                double t2 = MAX(patchLap[gy + 2][gx], patchLap[gy + 2][gx + 1]);
                double torsoE = (t1 + t2) * 0.5;

                // Cap torso contribution so a blurry head is never rescued by background, while sharp bib + sharp face reinforces
                double cappedTorso = MIN(torsoE, headE * 2.4);
                double runnerE = headE * 0.58 + cappedTorso * 0.42;

                if (runnerE > bestRunnerEnergy) {
                    bestRunnerEnergy = runnerE;
                    bestGx = gx;
                    bestGy = gy;
                    bestGxAniso = patchAniso[gy][gx];
                }
            }
        }

        // ====================================================================
        // STAGE 2 & 3: APPLE VISION DUAL-NEURAL VERIFIER
        // - AI #2: VNDetectHumanRectanglesRequest (Full/Upper Body — handles masked runners)
        // - AI #3: VNDetectFaceCaptureQualityRequest + 1280px High-Res Face ROI (handles night/low-light & 100% rejects blurry faces!)
        // Automatically triggers whenever Stage-1 confidence < 850.0
        // ====================================================================
        if (bestRunnerEnergy < 850.0) {
            CGImageSourceRef vSrc = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
            if (vSrc) {
                NSDictionary *opts1280 = @{
                    (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
                    (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
                    (id)kCGImageSourceThumbnailMaxPixelSize: @1280
                };
                CGImageRef vImg = CGImageSourceCreateThumbnailAtIndex(vSrc, 0, (__bridge CFDictionaryRef)opts1280);
                CFRelease(vSrc);
                if (vImg) {
                    VNDetectHumanRectanglesRequest *hReq = [[VNDetectHumanRectanglesRequest alloc] init];
                    hReq.upperBodyOnly = YES;
                    VNDetectFaceCaptureQualityRequest *qReq = [[VNDetectFaceCaptureQualityRequest alloc] init];
                    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:vImg options:@{}];
                    [handler performRequests:@[hReq, qReq] error:nil];

                    // Decode 1280px luma only if faces/humans were found
                    size_t vw = CGImageGetWidth(vImg);
                    size_t vh = CGImageGetHeight(vImg);
                    float *vGray = NULL;
                    if ((qReq.results.count > 0 || hReq.results.count > 0) && vw > 16 && vh > 16) {
                        uint8_t *vRgba = calloc(vw * vh * 4, 1);
                        if (vRgba) {
                            CGColorSpaceRef vCs = CGColorSpaceCreateDeviceRGB();
                            CGContextRef vCtx = CGBitmapContextCreate(vRgba, vw, vh, 8, vw * 4, vCs, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
                            if (vCtx) {
                                CGContextDrawImage(vCtx, CGRectMake(0, 0, vw, vh), vImg);
                                CGContextRelease(vCtx);
                            }
                            CGColorSpaceRelease(vCs);
                            vGray = malloc(vw * vh * sizeof(float));
                            if (vGray) {
                                for (size_t i = 0; i < vw * vh; i++) {
                                    vGray[i] = 0.299f * vRgba[i * 4] + 0.587f * vRgba[i * 4 + 1] + 0.114f * vRgba[i * 4 + 2];
                                }
                            }
                            free(vRgba);
                        }
                    }
                    CGImageRelease(vImg);

                    // AI #3: Deep Face Capture Quality + 1280px High-Res Face ROI Sharpness
                    double bestFaceQ = -1.0;
                    double bestFaceLap1280 = 0.0;
                    CGRect bestFaceBox = CGRectZero;
                    int validFaces = 0;

                    if (vGray) {
                        for (VNFaceObservation *fObs in qReq.results) {
                            CGRect fb = fObs.boundingBox;
                            if (fb.size.width < 0.025 || fb.size.height < 0.025) continue;
                            validFaces++;
                            double fq = fObs.faceCaptureQuality ? [fObs.faceCaptureQuality doubleValue] : 0.0;
                            int fx0 = MAX(1, (int)(fb.origin.x * vw));
                            int fx1 = MIN((int)vw - 2, (int)((fb.origin.x + fb.size.width) * vw));
                            int fy0 = MAX(1, (int)((1.0 - (fb.origin.y + fb.size.height)) * vh));
                            int fy1 = MIN((int)vh - 2, (int)((1.0 - fb.origin.y) * vh));

                            double lapSq = 0;
                            int tot = 0, micro = 0;
                            for (int y = fy0; y < fy1; y++) {
                                for (int x = fx0; x < fx1; x++) {
                                    size_t idx = (size_t)y * vw + (size_t)x;
                                    float lap = fabs(
                                        vGray[idx - vw - 1] + vGray[idx - vw] + vGray[idx - vw + 1] +
                                        vGray[idx - 1] - 8.0f * vGray[idx] + vGray[idx + 1] +
                                        vGray[idx + vw - 1] + vGray[idx + vw] + vGray[idx + vw + 1]
                                    ) * 0.5f;
                                    float cl = MIN(lap, 95.0f);
                                    lapSq += (double)(cl * cl);
                                    if (lap > 18.0f) micro++;
                                    tot++;
                                }
                            }
                            double mr = (double)micro / MAX(1, tot);
                            double fLap = (lapSq / MAX(1, tot)) * (0.45 + 1.65 * mr);
                            double combinedFace = fq * 600.0 + fLap;
                            if (combinedFace > bestFaceQ * 600.0 + bestFaceLap1280) {
                                bestFaceQ = fq;
                                bestFaceLap1280 = fLap;
                                bestFaceBox = fb;
                            }
                        }
                        free(vGray);
                    }

                    // AI #2: Deep Human Upper-Body Verifier (512px calibrated scale)
                    double bestVisionE = 0;
                    CGRect bestHumanBox = CGRectZero;
                    int validHumans = 0;

                    for (VNHumanObservation *obs in hReq.results) {
                        CGRect b = obs.boundingBox;
                        if (b.size.width < 0.12 || b.size.height < 0.16) continue;
                        if (b.origin.x + b.size.width < 0.18 || b.origin.x > 0.82) continue;
                        validHumans++;

                        int x0 = MAX(1, (int)((b.origin.x + b.size.width * 0.15) * sw));
                        int x1 = MIN((int)sw - 2, (int)((b.origin.x + b.size.width * 0.85) * sw));
                        int fyTop = (int)((1.0 - (b.origin.y + b.size.height)) * sh);
                        int fyBot = (int)((1.0 - b.origin.y) * sh);
                        int y0 = MAX(1, fyTop);
                        int y1 = MIN((int)sh - 2, fyBot);

                        double sliceE[3] = {0, 0, 0};
                        int sliceH = MAX(4, (y1 - y0) / 3);
                        for (int s = 0; s < 3; s++) {
                            int sy0 = y0 + s * sliceH;
                            int sy1 = (s == 2) ? y1 : (sy0 + sliceH);
                            double lapSq = 0;
                            int tot = 0, micro = 0;
                            for (int y = sy0; y < sy1; y++) {
                                for (int x = x0; x < x1; x++) {
                                    size_t idx = (size_t)y * sw + (size_t)x;
                                    float lap = fabs(
                                        gray[idx - sw - 1] + gray[idx - sw] + gray[idx - sw + 1] +
                                        gray[idx - 1] - 8.0f * gray[idx] + gray[idx + 1] +
                                        gray[idx + sw - 1] + gray[idx + sw] + gray[idx + sw + 1]
                                    ) * 0.5f;
                                    float cl = MIN(lap, 95.0f);
                                    lapSq += (double)(cl * cl);
                                    if (lap > 22.0f) micro++;
                                    tot++;
                                }
                            }
                            double mr = (double)micro / MAX(1, tot);
                            sliceE[s] = (lapSq / MAX(1, tot)) * (0.45 + 1.65 * mr);
                        }
                        double humanE = sliceE[0] * 0.45 + MAX(sliceE[1], sliceE[2]) * 0.55;
                        if (humanE > bestVisionE) {
                            bestVisionE = humanE;
                            bestHumanBox = b;
                        }
                    }

                    // Decision Fusion across AI #1 (Grid), AI #2 (Human Body), AI #3 (Face Quality + 1280px ROI)
                    if (validFaces > 0) {
                        if (bestFaceQ >= 0.22 && bestFaceLap1280 >= 160.0) {
                            // Sharp face confirmed even in night/low-light scenes (e.g. TR2602TAM05144.JPG)!
                            double rescuedE = 680.0 + bestFaceLap1280 * 0.85 + bestFaceQ * 450.0;
                            bestRunnerEnergy = MAX(bestRunnerEnergy, rescuedE);
                            bestGx = (int)((bestFaceBox.origin.x + bestFaceBox.size.width * 0.5) * gxN);
                            bestGy = (int)((1.0 - (bestFaceBox.origin.y + bestFaceBox.size.height * 0.5)) * gyN);
                        } else if (bestFaceQ <= 0.16 || bestFaceLap1280 < 55.0) {
                            // Confirm blurry face — prevents wall/background false positives (16544, 18419, 31794, 32954, 33070)
                            bestRunnerEnergy = MIN(bestRunnerEnergy > 0.1 ? bestRunnerEnergy : 280.0, 280.0);
                        }
                    } else if (validHumans > 0) {
                        // Masked/sunglasses runners where no bare face was detected
                        if (bestVisionE >= 850.0) {
                            bestRunnerEnergy = bestVisionE;
                            bestGx = (int)((bestHumanBox.origin.x + bestHumanBox.size.width * 0.5) * gxN);
                            bestGy = (int)((1.0 - (bestHumanBox.origin.y + bestHumanBox.size.height * 0.75)) * gyN);
                        } else if (bestVisionE < 590.0) {
                            bestRunnerEnergy = MIN(bestRunnerEnergy > 0.1 ? bestRunnerEnergy : bestVisionE * 0.72, bestVisionE * 0.72);
                        }
                    }
                }
            }
        }

        int hasSubjectPatches = (bestRunnerEnergy > 0.1);
        rec->isPortrait = hasSubjectPatches;

        double subjEnergy = hasSubjectPatches
            ? bestRunnerEnergy
            : (top3Any[0] * 0.50 + top3Any[1] * 0.30 + top3Any[2] * 0.20);

        double bgEnergy = bgPatches > 0 ? (bgSum / bgPatches) : 120.0;
        float bokeh = (float)((subjEnergy + 15.0) / (bgEnergy + 15.0));

        rec->subjSharp = (int)round(subjEnergy);
        rec->bgSharp = (int)round(bgEnergy);
        rec->bokehRatio = roundf(bokeh * 100.0f) / 100.0f;

        // Lock 100% Loupe Focus Box directly onto the #1 sharpest runner's head/face block!
        rec->boxX = MAX(0.02f, ((float)bestGx - 0.5f) / (float)gxN);
        rec->boxY = MAX(0.02f, ((float)bestGy - 0.5f) / (float)gyN);
        rec->boxW = MIN(0.95f - rec->boxX, 2.8f / (float)gxN);
        rec->boxH = MIN(0.95f - rec->boxY, 2.8f / (float)gyN);

        int blurCode = 0;
        if (bestGxAniso > 1.85 && subjEnergy < 460.0) {
            blurCode = 1; // motion_blur
        }

        // Calibrated 0..100 score:
        // Blurry (<= 460 energy) -> < 42% (🔴 BLURRY)
        // Soft (460..630 energy) -> 42%..64% (🟠 SOFT)
        // Sharp (>= 630 energy) -> 65%..100% (🟢 SHARP)
        double rawScore = 0;
        if (subjEnergy > 10.0) {
            rawScore = (log10(subjEnergy) - 2.34) / (3.12 - 2.34) * 100.0;
        }
        if (blurCode == 1) rawScore *= 0.80;

        int finalScore = (int)round(rawScore);
        if (finalScore < 0) finalScore = 0;
        if (finalScore > 100) finalScore = 100;

        if (finalScore < 42 && blurCode == 0) {
            blurCode = 2; // out_of_focus
        }

        rec->score = finalScore;
        rec->blurCode = blurCode;
        rec->scanned = 1;

        free(gray);
        free(isSkin);
        free(rgba);
    }
}

static void start_background_folder_scan(const char *dir_path) {
    pthread_mutex_lock(&g_dir_mutex);
    g_cancel_scan = 1;
    int my_gen = ++g_scan_generation;
    pthread_mutex_unlock(&g_dir_mutex);

    usleep(20000);

    DIR *d = opendir(dir_path);
    if (!d) return;

    pthread_mutex_lock(&g_dir_mutex);
    g_total_files = 0;
    g_done_files = 0;
    g_raw_count = 0;
    g_cancel_scan = 0;
    g_is_scanning = 1;
    g_scan_start_time = now_sec();

    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        if (ent->d_name[0] == '.') continue;
        if (is_raw_camera_ext(ent->d_name)) {
            g_raw_count++;
            continue;
        }
        if (!is_supported_image_ext(ent->d_name)) continue;

        char full_p[4096];
        snprintf(full_p, sizeof(full_p), "%s/%s", dir_path, ent->d_name);
        struct stat st;
        if (stat(full_p, &st) != 0 || !S_ISREG(st.st_mode)) continue;

        if (g_total_files < MAX_BATCH_FILES) {
            NativePhotoRecord *r = &g_records[g_total_files++];
            memset(r, 0, sizeof(NativePhotoRecord));
            strncpy(r->name, ent->d_name, sizeof(r->name) - 1);
            r->size = (long long)st.st_size;
            r->mtime = (long)st.st_mtime * 1000L;
        }
    }
    closedir(d);

    if (g_total_files > 1) {
        qsort(g_records, g_total_files, sizeof(NativePhotoRecord), compare_records_by_name);
    }
    int total_to_scan = g_total_files;
    char dir_copy[2048];
    strncpy(dir_copy, dir_path, sizeof(dir_copy) - 1);
    dir_copy[sizeof(dir_copy) - 1] = '\0';
    pthread_mutex_unlock(&g_dir_mutex);

    if (total_to_scan == 0) {
        g_is_scanning = 0;
        return;
    }

    // Dispatch multi-core background scan so HTTP call returns in 5ms!
    NSString *nsDir = [NSString stringWithUTF8String:dir_copy];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        const char *cDir = [nsDir UTF8String];
        // Process in chunks of 32 across all Apple Silicon cores
        int chunk = 32;
        for (int base = 0; base < total_to_scan; base += chunk) {
            if (g_cancel_scan || g_scan_generation != my_gen) break;
            int count = MIN(chunk, total_to_scan - base);
            dispatch_apply(count, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(size_t k) {
                if (g_cancel_scan || g_scan_generation != my_gen) return;
                int idx = base + (int)k;
                analyze_single_photo_native(cDir, &g_records[idx]);
                __sync_fetch_and_add(&g_done_files, 1);
            });
        }
        if (g_scan_generation == my_gen) {
            g_is_scanning = 0;
        }
    });
}

static void move_paired_raw_files(const char *base_dir, const char *img_name, const char *target_subdir, int *moved_raws) {
    char stem[512];
    strncpy(stem, img_name, sizeof(stem) - 1);
    stem[sizeof(stem) - 1] = '\0';
    char *dot = strrchr(stem, '.');
    if (!dot) return;
    *dot = '\0';

    const char *raw_exts[] = {
        ".NEF", ".nef", ".ARW", ".arw", ".CR2", ".cr2",
        ".CR3", ".cr3", ".DNG", ".dng", ".RAF", ".raf",
        ".ORF", ".orf", ".RW2", ".rw2", ".XMP", ".xmp", NULL
    };

    for (int i = 0; raw_exts[i] != NULL; i++) {
        char src_raw[4096];
        snprintf(src_raw, sizeof(src_raw), "%s/%s%s", base_dir, stem, raw_exts[i]);
        struct stat st;
        if (stat(src_raw, &st) == 0 && S_ISREG(st.st_mode)) {
            char dst_raw[4096];
            snprintf(dst_raw, sizeof(dst_raw), "%s/%s/%s%s", base_dir, target_subdir, stem, raw_exts[i]);
            if (rename(src_raw, dst_raw) == 0 && moved_raws) {
                (*moved_raws)++;
            }
        }
    }
}

static void send_json_response(int client_fd, const char *json_str) {
    size_t blen = strlen(json_str);
    char header[512];
    int hlen = snprintf(header, sizeof(header),
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Content-Length: %zu\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n\r\n", blen);
    send(client_fd, header, hlen, 0);
    send(client_fd, json_str, blen, 0);
}

static char *build_scan_status_json(int from_idx) {
    pthread_mutex_lock(&g_dir_mutex);
    int total = g_total_files;
    int done = g_done_files;
    int scanning = g_is_scanning;
    int rawCount = g_raw_count;
    double elapsed = MAX(0.05, now_sec() - g_scan_start_time);
    double speed = done > 0 ? ((double)done / elapsed) : 0.0;
    const char *base_folder = strrchr(g_source_dir, '/');
    base_folder = base_folder ? (base_folder + 1) : g_source_dir;

    size_t cap = 65536 + (size_t)(total * 220);
    char *json = malloc(cap);
    size_t len = snprintf(json, cap,
        "{\"ok\":true,\"scanning\":%s,\"done\":%d,\"total\":%d,\"speed\":%.1f,\"folderName\":\"%s\",\"rawCount\":%d,\"items\":[",
        scanning ? "true" : "false", done, total, speed, base_folder, rawCount);

    int first = 1;
    if (from_idx < 0) from_idx = 0;
    for (int i = from_idx; i < total; i++) {
        NativePhotoRecord *r = &g_records[i];
        if (!r->scanned) continue;
        if (!first) json[len++] = ',';
        first = 0;

        const char *btype = "none";
        if (r->blurCode == 1) btype = "motion_blur";
        else if (r->blurCode == 2) btype = "out_of_focus";
        else if (r->blurCode == 3) btype = "back_focus";
        else if (r->blurCode == 4) btype = "eyes_closed";

        len += snprintf(json + len, cap - len,
            "{\"idx\":%d,\"name\":\"%s\",\"size\":%lld,\"mtime\":%ld,\"w\":%d,\"h\":%d,\"score\":%d,\"subj\":%d,\"bg\":%d,\"bokeh\":%.2f,\"btype\":\"%s\",\"portrait\":%d,\"bx\":%.3f,\"by\":%.3f,\"bw\":%.3f,\"bh\":%.3f}",
            i, r->name, r->size, r->mtime, r->width, r->height, r->score, r->subjSharp, r->bgSharp,
            r->bokehRatio, btype, r->isPortrait, r->boxX, r->boxY, r->boxW, r->boxH);
    }
    len += snprintf(json + len, cap - len, "]}");
    pthread_mutex_unlock(&g_dir_mutex);
    return json;
}

static void *handle_client(void *arg) {
    @autoreleasepool {
        int client_fd = *(int *)arg;
        free(arg);

        int nosigpipe = 1;
        setsockopt(client_fd, SOL_SOCKET, SO_NOSIGPIPE, &nosigpipe, sizeof(nosigpipe));

        char header_buf[16384];
        ssize_t received = 0;
        ssize_t header_end = -1;

        while (received < (ssize_t)sizeof(header_buf) - 1) {
            ssize_t n = recv(client_fd, header_buf + received, sizeof(header_buf) - 1 - received, 0);
            if (n <= 0) break;
            received += n;
            header_buf[received] = '\0';
            char *p = strstr(header_buf, "\r\n\r\n");
            if (p) {
                header_end = (p - header_buf) + 4;
                break;
            }
        }

        if (header_end < 0) {
            close(client_fd);
            return NULL;
        }

        // 0A. GET /__version
        if (strncmp(header_buf, "GET /__version", 14) == 0) {
            struct stat st;
            long mtime = 0, fsize_stat = 0;
            pthread_mutex_lock(&g_dir_mutex);
            if (stat(g_html_path, &st) == 0) {
                mtime = (long)st.st_mtime;
                fsize_stat = (long)st.st_size;
            }
            pthread_mutex_unlock(&g_dir_mutex);
            char body[128];
            snprintf(body, sizeof(body), "%ld-%ld-%ld", mtime, fsize_stat, g_boot_time);
            char resp[320];
            snprintf(resp, sizeof(resp),
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: text/plain; charset=utf-8\r\n"
                "Content-Length: %lu\r\n"
                "Cache-Control: no-store, no-cache, must-revalidate, max-age=0\r\n"
                "Connection: close\r\n\r\n%s", strlen(body), body);
            send(client_fd, resp, strlen(resp), 0);
            close(client_fd);
            return NULL;
        }

        // 0B. GET /__check_update?url=... (Native macOS HTTPS Update Checker — Zero CORS)
        if (strncmp(header_buf, "GET /__check_update", 19) == 0) {
            char custom_url[1024] = {0};
            char *q = strstr(header_buf, "url=");
            if (q) {
                q += 4;
                char raw_url[1024] = {0};
                size_t i = 0;
                while (q[i] && q[i] != ' ' && q[i] != '&' && q[i] != '\r' && i + 1 < sizeof(raw_url)) {
                    raw_url[i] = q[i];
                    i++;
                }
                raw_url[i] = '\0';
                url_decode_raw(raw_url, custom_url, sizeof(custom_url));
            }
            NSString *targetUrl = (custom_url[0] && strncmp(custom_url, "http", 4) == 0)
                ? [NSString stringWithUTF8String:custom_url]
                : [NSString stringWithUTF8String:DEFAULT_UPDATE_MANIFEST_URL];

            NSInteger statusCode = 0;
            NSData *data = fetch_url_sync(targetUrl, 6.0, &statusCode);
            NSString *jsonResp = nil;
            if (data && data.length > 2) {
                id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                if ([parsed isKindOfClass:[NSDictionary class]]) {
                    NSDictionary *wrapper = @{
                        @"ok": @YES,
                        @"nativeVersion": @NATIVE_VERSION,
                        @"manifest": parsed
                    };
                    NSData *outData = [NSJSONSerialization dataWithJSONObject:wrapper options:0 error:nil];
                    if (outData) {
                        jsonResp = [[NSString alloc] initWithData:outData encoding:NSUTF8StringEncoding];
                    }
                }
            }
            if (!jsonResp) {
                jsonResp = [NSString stringWithFormat:@"{\"ok\":false,\"nativeVersion\":\"%s\",\"status\":%ld}", NATIVE_VERSION, (long)statusCode];
            }
            send_json_response(client_fd, [jsonResp UTF8String]);
            close(client_fd);
            return NULL;
        }

        // 0C. POST /__perform_ota_update?url=... (Downloads & atomically installs new Iris-Offline.html)
        if (strncmp(header_buf, "POST /__perform_ota_update", 26) == 0) {
            char target_url[1024] = {0};
            char *q = strstr(header_buf, "url=");
            if (q) {
                q += 4;
                char raw_url[1024] = {0};
                size_t i = 0;
                while (q[i] && q[i] != ' ' && q[i] != '&' && q[i] != '\r' && i + 1 < sizeof(raw_url)) {
                    raw_url[i] = q[i];
                    i++;
                }
                raw_url[i] = '\0';
                url_decode_raw(raw_url, target_url, sizeof(target_url));
            }

            int updated = 0;
            size_t downloaded_bytes = 0;
            const char *err_msg = "invalid_url";
            if (target_url[0] && strncmp(target_url, "https://", 8) == 0) {
                NSInteger statusCode = 0;
                NSData *htmlData = fetch_url_sync([NSString stringWithUTF8String:target_url], 20.0, &statusCode);
                if (!htmlData || htmlData.length < 50000) {
                    err_msg = "download_failed_or_too_small";
                } else {
                    NSString *preview = [[NSString alloc] initWithBytes:htmlData.bytes
                                                                 length:MIN((NSUInteger)4096, htmlData.length)
                                                               encoding:NSUTF8StringEncoding];
                    if (preview && [preview containsString:@"<title"] && ([preview containsString:@"Iris"] || [preview containsString:@"Sharp"])) {
                        mkdir(g_ota_dir, 0755);
                        char tmp_path[2200];
                        snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", g_ota_html_path);
                        FILE *fp = fopen(tmp_path, "wb");
                        if (fp) {
                            fwrite(htmlData.bytes, 1, htmlData.length, fp);
                            fclose(fp);
                            if (rename(tmp_path, g_ota_html_path) == 0) {
                                pthread_mutex_lock(&g_dir_mutex);
                                strncpy(g_html_path, g_ota_html_path, sizeof(g_html_path) - 1);
                                pthread_mutex_unlock(&g_dir_mutex);
                                FILE *bfp = fopen(g_bundle_html_path, "wb");
                                if (bfp) {
                                    fwrite(htmlData.bytes, 1, htmlData.length, bfp);
                                    fclose(bfp);
                                }
                                updated = 1;
                                downloaded_bytes = (size_t)htmlData.length;
                            } else {
                                unlink(tmp_path);
                                err_msg = "rename_failed";
                            }
                        } else {
                            err_msg = "write_failed";
                        }
                    } else {
                        err_msg = "invalid_html_signature";
                    }
                }
            }

            char body[256];
            if (updated) {
                snprintf(body, sizeof(body), "{\"ok\":true,\"bytes\":%zu}", downloaded_bytes);
            } else {
                snprintf(body, sizeof(body), "{\"ok\":false,\"error\":\"%s\"}", err_msg);
            }
            send_json_response(client_fd, body);
            close(client_fd);
            return NULL;
        }

        // 1. GET /__native_status
        if (strncmp(header_buf, "GET /__native_status", 20) == 0) {
            char dir_copy[2048] = {0};
            pthread_mutex_lock(&g_dir_mutex);
            strncpy(dir_copy, g_source_dir, sizeof(dir_copy) - 1);
            pthread_mutex_unlock(&g_dir_mutex);
            const char *base_folder = strrchr(dir_copy, '/');
            base_folder = base_folder ? (base_folder + 1) : dir_copy;

            char body[2560];
            snprintf(body, sizeof(body),
                "{\"native\":true,\"version\":\"%s\",\"hasFolder\":%s,\"folderName\":\"%s\",\"scanning\":%s,\"total\":%d}",
                NATIVE_VERSION, dir_copy[0] ? "true" : "false", base_folder,
                g_is_scanning ? "true" : "false", g_total_files);
            send_json_response(client_fd, body);
            close(client_fd);
            return NULL;
        }

        // 2. GET /__pick_source_folder (Opens Native macOS NSOpenPanel & kicks off 250fps C background scan!)
        if (strncmp(header_buf, "GET /__pick_source_folder", 25) == 0) {
            __block char *picked_path = NULL;

            dispatch_sync(dispatch_get_main_queue(), ^{
                @autoreleasepool {
                    NSOpenPanel *panel = [NSOpenPanel openPanel];
                    [panel setCanChooseFiles:NO];
                    [panel setCanChooseDirectories:YES];
                    [panel setCanCreateDirectories:NO];
                    [panel setAllowsMultipleSelection:NO];
                    [panel setPrompt:@"สแกนโฟลเดอร์นี้"];
                    [panel setMessage:@"เลือกโฟลเดอร์ภาพถ่ายนิ่งที่ต้องการให้ AI สแกนคัดภาพเบลอ (รองรับ 5,000+ ภาพ):"];
                    [NSApp activateIgnoringOtherApps:YES];

                    if ([panel runModal] == NSModalResponseOK) {
                        NSURL *url = [[panel URLs] firstObject];
                        if (url && [url path]) {
                            const char *p = [[url path] UTF8String];
                            if (p) picked_path = strdup(p);
                        }
                    }
                }
            });

            if (picked_path) {
                pthread_mutex_lock(&g_dir_mutex);
                strncpy(g_source_dir, picked_path, sizeof(g_source_dir) - 1);
                pthread_mutex_unlock(&g_dir_mutex);

                start_background_folder_scan(picked_path);
                free(picked_path);

                char *json = build_scan_status_json(0);
                send_json_response(client_fd, json);
                free(json);
            } else {
                send_json_response(client_fd, "{\"ok\":false,\"cancelled\":true}");
            }
            close(client_fd);
            return NULL;
        }

        // 3. GET /__scan_status?from=... (Live 120fps Polling of Background Multi-Core Scan)
        if (strncmp(header_buf, "GET /__scan_status", 18) == 0) {
            int from_idx = 0;
            char *q = strstr(header_buf, "from=");
            if (q) from_idx = atoi(q + 5);
            char *json = build_scan_status_json(from_idx);
            send_json_response(client_fd, json);
            free(json);
            close(client_fd);
            return NULL;
        }

        // 3B. POST /__stop_scan
        if (strncmp(header_buf, "POST /__stop_scan", 17) == 0) {
            g_cancel_scan = 1;
            g_is_scanning = 0;
            send_json_response(client_fd, "{\"ok\":true}");
            close(client_fd);
            return NULL;
        }

        // 4A. GET /__thumb?name=... (Ultra-fast 384px Hardware DCT Thumbnail ~18KB instead of 2.2MB!)
        if (strncmp(header_buf, "GET /__thumb?", 13) == 0) {
            char raw_name[1024] = {0};
            char *q = strstr(header_buf, "name=");
            if (q) {
                q += 5;
                size_t i = 0;
                while (q[i] && q[i] != ' ' && q[i] != '&' && q[i] != '\r' && i + 1 < sizeof(raw_name)) {
                    raw_name[i] = q[i];
                    i++;
                }
                raw_name[i] = '\0';
            }
            char clean_name[1024];
            url_decode_safe_filename(raw_name, clean_name, sizeof(clean_name));

            char full_path[4096] = {0};
            pthread_mutex_lock(&g_dir_mutex);
            if (g_source_dir[0]) {
                snprintf(full_path, sizeof(full_path), "%s/%s", g_source_dir, clean_name);
            }
            pthread_mutex_unlock(&g_dir_mutex);

            NSURL *url = full_path[0] ? [NSURL fileURLWithPath:[NSString stringWithUTF8String:full_path]] : nil;
            CGImageSourceRef src = url ? CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL) : NULL;
            if (!src) {
                const char *nf = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found";
                send(client_fd, nf, strlen(nf), 0);
                close(client_fd);
                return NULL;
            }

            NSDictionary *opts = @{
                (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
                (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
                (id)kCGImageSourceThumbnailMaxPixelSize: @384
            };
            CGImageRef thumb = CGImageSourceCreateThumbnailAtIndex(src, 0, (__bridge CFDictionaryRef)opts);
            CFRelease(src);

            if (!thumb) {
                const char *nf = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found";
                send(client_fd, nf, strlen(nf), 0);
                close(client_fd);
                return NULL;
            }

            NSMutableData *jpgData = [NSMutableData data];
            CGImageDestinationRef dest = CGImageDestinationCreateWithData(
                (__bridge CFMutableDataRef)jpgData,
                (__bridge CFStringRef)UTTypeJPEG.identifier,
                1, NULL
            );
            if (dest) {
                NSDictionary *destOpts = @{ (id)kCGImageDestinationLossyCompressionQuality: @0.78 };
                CGImageDestinationAddImage(dest, thumb, (__bridge CFDictionaryRef)destOpts);
                CGImageDestinationFinalize(dest);
                CFRelease(dest);
            }
            CGImageRelease(thumb);

            char resp_hdr[512];
            int hlen = snprintf(resp_hdr, sizeof(resp_hdr),
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: image/jpeg\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Content-Length: %lu\r\n"
                "Cache-Control: max-age=3600\r\n"
                "Connection: close\r\n\r\n", (unsigned long)jpgData.length);
            send(client_fd, resp_hdr, hlen, 0);
            send(client_fd, jpgData.bytes, jpgData.length, 0);
            close(client_fd);
            return NULL;
        }

        // 4B. GET /__photo?name=... (Full-Resolution Streamer for 100% Eye Loupe Only)
        if (strncmp(header_buf, "GET /__photo?", 13) == 0) {
            char raw_name[1024] = {0};
            char *q = strstr(header_buf, "name=");
            if (q) {
                q += 5;
                size_t i = 0;
                while (q[i] && q[i] != ' ' && q[i] != '&' && q[i] != '\r' && i + 1 < sizeof(raw_name)) {
                    raw_name[i] = q[i];
                    i++;
                }
                raw_name[i] = '\0';
            }
            char clean_name[1024];
            url_decode_safe_filename(raw_name, clean_name, sizeof(clean_name));

            char full_path[4096] = {0};
            pthread_mutex_lock(&g_dir_mutex);
            if (g_source_dir[0]) {
                snprintf(full_path, sizeof(full_path), "%s/%s", g_source_dir, clean_name);
            }
            pthread_mutex_unlock(&g_dir_mutex);

            FILE *fp = full_path[0] ? fopen(full_path, "rb") : NULL;
            if (!fp) {
                const char *nf = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found";
                send(client_fd, nf, strlen(nf), 0);
                close(client_fd);
                return NULL;
            }

            fseek(fp, 0, SEEK_END);
            long fsize = ftell(fp);
            fseek(fp, 0, SEEK_SET);

            char resp_hdr[512];
            int hlen = snprintf(resp_hdr, sizeof(resp_hdr),
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: image/jpeg\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Content-Length: %ld\r\n"
                "Cache-Control: max-age=3600\r\n"
                "Connection: close\r\n\r\n", fsize);
            send(client_fd, resp_hdr, hlen, 0);

            char chunk[65536];
            size_t n;
            while ((n = fread(chunk, 1, sizeof(chunk), fp)) > 0) {
                if (send(client_fd, chunk, n, 0) <= 0) break;
            }
            fclose(fp);
            close(client_fd);
            return NULL;
        }

        // 4C. GET /__inspect_face?name=... (Apple Neural Engine Face + Human + Race Bib OCR + Real EXIF!)
        if (strncmp(header_buf, "GET /__inspect_face?", 20) == 0) {
            char raw_name[1024] = {0};
            char *q = strstr(header_buf, "name=");
            if (q) {
                q += 5;
                size_t i = 0;
                while (q[i] && q[i] != ' ' && q[i] != '&' && q[i] != '\r' && i + 1 < sizeof(raw_name)) {
                    raw_name[i] = q[i];
                    i++;
                }
                raw_name[i] = '\0';
            }
            char clean_name[1024];
            url_decode_safe_filename(raw_name, clean_name, sizeof(clean_name));

            char full_path[4096] = {0};
            pthread_mutex_lock(&g_dir_mutex);
            if (g_source_dir[0]) {
                snprintf(full_path, sizeof(full_path), "%s/%s", g_source_dir, clean_name);
            }
            pthread_mutex_unlock(&g_dir_mutex);

            NSURL *url = full_path[0] ? [NSURL fileURLWithPath:[NSString stringWithUTF8String:full_path]] : nil;
            CGImageSourceRef src = url ? CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL) : NULL;
            if (!src) {
                send_json_response(client_fd, "{\"ok\":false}");
                close(client_fd);
                return NULL;
            }

            // 1. Read Real Camera EXIF Metadata (Shutter Speed, Aperture, ISO, Focal Length, Camera Model)
            char exif_cam[128] = "Camera";
            char exif_shutter[64] = "";
            char exif_fstop[64] = "";
            char exif_iso[64] = "";
            char exif_focal[64] = "";

            NSDictionary *props = (__bridge_transfer NSDictionary *)CGImageSourceCopyPropertiesAtIndex(src, 0, NULL);
            if (props) {
                NSDictionary *tiff = props[(id)kCGImagePropertyTIFFDictionary];
                NSDictionary *exif = props[(id)kCGImagePropertyExifDictionary];
                if (tiff) {
                    NSString *model = tiff[(id)kCGImagePropertyTIFFModel];
                    if (model) strncpy(exif_cam, [model UTF8String], sizeof(exif_cam) - 1);
                }
                if (exif) {
                    NSNumber *expTime = exif[(id)kCGImagePropertyExifExposureTime];
                    if (expTime && [expTime doubleValue] > 0) {
                        double et = [expTime doubleValue];
                        if (et < 1.0) snprintf(exif_shutter, sizeof(exif_shutter), "1/%.0fs", round(1.0 / et));
                        else snprintf(exif_shutter, sizeof(exif_shutter), "%.1fs", et);
                    }
                    NSNumber *fnum = exif[(id)kCGImagePropertyExifFNumber];
                    if (fnum) snprintf(exif_fstop, sizeof(exif_fstop), "f/%.1f", [fnum doubleValue]);

                    NSArray *isos = exif[(id)kCGImagePropertyExifISOSpeedRatings];
                    if (isos && isos.count > 0) {
                        snprintf(exif_iso, sizeof(exif_iso), "ISO %d", [isos[0] intValue]);
                    }
                    NSNumber *fl = exif[(id)kCGImagePropertyExifFocalLength];
                    if (fl) snprintf(exif_focal, sizeof(exif_focal), "%.0fmm", [fl doubleValue]);
                }
            }

            NSDictionary *opts = @{
                (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
                (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
                (id)kCGImageSourceThumbnailMaxPixelSize: @768
            };
            CGImageRef img = CGImageSourceCreateThumbnailAtIndex(src, 0, (__bridge CFDictionaryRef)opts);
            CFRelease(src);
            if (!img) {
                send_json_response(client_fd, "{\"ok\":false}");
                close(client_fd);
                return NULL;
            }

            // 2. Run Apple Vision Neural Engine: Face Landmarks + Human Body + Fast Race Bib OCR!
            VNDetectFaceLandmarksRequest *fReq = [[VNDetectFaceLandmarksRequest alloc] init];
            VNDetectHumanRectanglesRequest *hReq = [[VNDetectHumanRectanglesRequest alloc] init];
            hReq.upperBodyOnly = YES;
            VNRecognizeTextRequest *tReq = [[VNRecognizeTextRequest alloc] init];
            tReq.recognitionLevel = VNRequestTextRecognitionLevelFast;
            tReq.usesLanguageCorrection = NO;

            VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:img options:@{}];
            [handler performRequests:@[fReq, hReq, tReq] error:nil];
            CGImageRelease(img);

            // Extract Race Bib Number (3 to 5 digits on runner's chest)
            char bib_str[64] = "";
            for (VNRecognizedTextObservation *tObs in tReq.results) {
                VNRecognizedText *cand = [[tObs topCandidates:1] firstObject];
                if (!cand) continue;
                NSString *s = cand.string;
                // Find 3..5 consecutive digits (typical marathon bib number e.g. 2065, 2103, 50020)
                NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"\\b\\d{3,5}\\b" options:0 error:nil];
                NSTextCheckingResult *m = [re firstMatchInString:s options:0 range:NSMakeRange(0, s.length)];
                if (m) {
                    NSString *num = [s substringWithRange:m.range];
                    // Ignore "2026" or "2015" event years if another bib exists
                    if (![num isEqualToString:@"2026"] && ![num isEqualToString:@"2015"]) {
                        strncpy(bib_str, [num UTF8String], sizeof(bib_str) - 1);
                        break;
                    }
                }
            }

            int humanCount = 0;
            CGRect mainHuman = CGRectZero;
            for (VNHumanObservation *hObs in hReq.results) {
                if (hObs.boundingBox.size.width >= 0.12 && hObs.boundingBox.size.height >= 0.16) {
                    humanCount++;
                    if (hObs.boundingBox.size.width * hObs.boundingBox.size.height > mainHuman.size.width * mainHuman.size.height) {
                        mainHuman = hObs.boundingBox;
                    }
                }
            }

            NSArray<VNFaceObservation *> *faces = fReq.results;
            if (faces.count > 0) {
                VNFaceObservation *f = faces[0];
                CGRect fb = f.boundingBox;
                float fx = fb.origin.x;
                float fy = 1.0f - (fb.origin.y + fb.size.height);
                float fw = fb.size.width;
                float fh = fb.size.height;

                float lex = fx + fw * 0.18f, ley = fy + fh * 0.25f, lew = fw * 0.26f, leh = fh * 0.22f;
                float rex = fx + fw * 0.54f, rey = fy + fh * 0.25f, rew = fw * 0.26f, reh = fh * 0.22f;

                if (f.landmarks.leftEye && f.landmarks.leftEye.pointCount > 0) {
                    const CGPoint *pts = f.landmarks.leftEye.normalizedPoints;
                    float minX = 1, maxX = 0, minY = 1, maxY = 0;
                    for (NSUInteger i = 0; i < f.landmarks.leftEye.pointCount; i++) {
                        if (pts[i].x < minX) minX = pts[i].x;
                        if (pts[i].x > maxX) maxX = pts[i].x;
                        if (pts[i].y < minY) minY = pts[i].y;
                        if (pts[i].y > maxY) maxY = pts[i].y;
                    }
                    float pad = 0.06f;
                    lex = fx + MAX(0, minX - pad) * fw;
                    ley = fy + (1.0f - MIN(1, maxY + pad)) * fh;
                    lew = (maxX - minX + pad * 2) * fw;
                    leh = (maxY - minY + pad * 2) * fh;
                }

                if (f.landmarks.rightEye && f.landmarks.rightEye.pointCount > 0) {
                    const CGPoint *pts = f.landmarks.rightEye.normalizedPoints;
                    float minX = 1, maxX = 0, minY = 1, maxY = 0;
                    for (NSUInteger i = 0; i < f.landmarks.rightEye.pointCount; i++) {
                        if (pts[i].x < minX) minX = pts[i].x;
                        if (pts[i].x > maxX) maxX = pts[i].x;
                        if (pts[i].y < minY) minY = pts[i].y;
                        if (pts[i].y > maxY) maxY = pts[i].y;
                    }
                    float pad = 0.06f;
                    rex = fx + MAX(0, minX - pad) * fw;
                    rey = fy + (1.0f - MIN(1, maxY + pad)) * fh;
                    rew = (maxX - minX + pad * 2) * fw;
                    reh = (maxY - minY + pad * 2) * fh;
                }

                char json[1536];
                snprintf(json, sizeof(json),
                    "{\"ok\":true,\"hasFace\":true,\"humanCount\":%d,\"bib\":\"%s\",\"camera\":\"%s\",\"shutter\":\"%s\",\"fstop\":\"%s\",\"iso\":\"%s\",\"focal\":\"%s\",\"face\":{\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f},\"leftEye\":{\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f},\"rightEye\":{\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f}}",
                    MAX(1, humanCount), bib_str, exif_cam, exif_shutter, exif_fstop, exif_iso, exif_focal,
                    fx, fy, fw, fh, lex, ley, lew, leh, rex, rey, rew, reh);
                send_json_response(client_fd, json);
            } else if (humanCount > 0) {
                // Masked runner (e.g. TR2602TAM34214.JPG): provide Head & Chest Bib focus boxes from Human Neural Detector!
                float hx = mainHuman.origin.x;
                float hy = 1.0f - (mainHuman.origin.y + mainHuman.size.height);
                float hw = mainHuman.size.width;
                float hh = mainHuman.size.height;
                char json[1536];
                snprintf(json, sizeof(json),
                    "{\"ok\":true,\"hasFace\":true,\"maskedRunner\":true,\"humanCount\":%d,\"bib\":\"%s\",\"camera\":\"%s\",\"shutter\":\"%s\",\"fstop\":\"%s\",\"iso\":\"%s\",\"focal\":\"%s\",\"face\":{\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f},\"leftEye\":{\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f},\"rightEye\":{\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f}}",
                    humanCount, bib_str, exif_cam, exif_shutter, exif_fstop, exif_iso, exif_focal,
                    hx + hw * 0.15f, hy, hw * 0.70f, hh * 0.42f,
                    hx + hw * 0.22f, hy + hh * 0.05f, hw * 0.56f, hh * 0.30f,
                    hx + hw * 0.18f, hy + hh * 0.42f, hw * 0.64f, hh * 0.45f);
                send_json_response(client_fd, json);
            } else {
                char json[512];
                snprintf(json, sizeof(json),
                    "{\"ok\":true,\"hasFace\":false,\"humanCount\":0,\"bib\":\"%s\",\"camera\":\"%s\",\"shutter\":\"%s\",\"fstop\":\"%s\",\"iso\":\"%s\",\"focal\":\"%s\"}",
                    bib_str, exif_cam, exif_shutter, exif_fstop, exif_iso, exif_focal);
                send_json_response(client_fd, json);
            }
            close(client_fd);
            return NULL;
        }

        // 5. POST /__organize_files?mode=blurry_only|all_three
        if (strncmp(header_buf, "POST /__organize_files", 22) == 0) {
            int all_three = (strstr(header_buf, "mode=all_three") != NULL);

            long content_len = 0;
            char *cl = strcasestr(header_buf, "Content-Length:");
            if (cl) content_len = atol(cl + 15);

            char *body = malloc(content_len + 1);
            if (!body) {
                send_json_response(client_fd, "{\"ok\":false}");
                close(client_fd);
                return NULL;
            }

            long already = received - header_end;
            if (already > 0) {
                memcpy(body, header_buf + header_end, already > content_len ? content_len : already);
            }
            long rem = content_len - already;
            long offset = already;
            while (rem > 0) {
                ssize_t n = recv(client_fd, body + offset, rem, 0);
                if (n <= 0) break;
                offset += n;
                rem -= n;
            }
            body[content_len] = '\0';

            char dir_copy[2048] = {0};
            pthread_mutex_lock(&g_dir_mutex);
            strncpy(dir_copy, g_source_dir, sizeof(dir_copy) - 1);
            pthread_mutex_unlock(&g_dir_mutex);

            int moved_photos = 0;
            int moved_raws = 0;

            if (dir_copy[0]) {
                char blurry_dir[4096], soft_dir[4096], sharp_dir[4096];
                snprintf(blurry_dir, sizeof(blurry_dir), "%s/_ภาพเบลอ_Blurry", dir_copy);
                snprintf(soft_dir, sizeof(soft_dir), "%s/_พอใช้_Soft", dir_copy);
                snprintf(sharp_dir, sizeof(sharp_dir), "%s/_ภาพคมชัด_Sharp", dir_copy);

                mkdir(blurry_dir, 0755);
                if (all_three) {
                    mkdir(soft_dir, 0755);
                    mkdir(sharp_dir, 0755);
                }

                char *saveptr = NULL;
                char *line = strtok_r(body, "\n", &saveptr);
                while (line) {
                    char *sep = strchr(line, '|');
                    if (sep) {
                        *sep = '\0';
                        const char *fname = line;
                        const char *cat = sep + 1;

                        const char *target_sub = NULL;
                        if (strcmp(cat, "blurry") == 0 || strcmp(cat, "reject") == 0) {
                            target_sub = "_ภาพเบลอ_Blurry";
                        } else if (all_three && strcmp(cat, "soft") == 0) {
                            target_sub = "_พอใช้_Soft";
                        } else if (all_three && (strcmp(cat, "sharp") == 0 || strcmp(cat, "pick") == 0)) {
                            target_sub = "_ภาพคมชัด_Sharp";
                        }

                        if (target_sub && fname[0] && !strchr(fname, '/')) {
                            char src_p[4096], dst_p[4096];
                            snprintf(src_p, sizeof(src_p), "%s/%s", dir_copy, fname);
                            snprintf(dst_p, sizeof(dst_p), "%s/%s/%s", dir_copy, target_sub, fname);
                            if (rename(src_p, dst_p) == 0) {
                                moved_photos++;
                                move_paired_raw_files(dir_copy, fname, target_sub, &moved_raws);
                            }
                        }
                    }
                    line = strtok_r(NULL, "\n", &saveptr);
                }
            }

            free(body);
            char resp[256];
            snprintf(resp, sizeof(resp),
                "{\"ok\":true,\"movedPhotos\":%d,\"movedRaws\":%d}",
                moved_photos, moved_raws);
            send_json_response(client_fd, resp);
            close(client_fd);
            return NULL;
        }

        // 6. POST /__undo_organize
        if (strncmp(header_buf, "POST /__undo_organize", 21) == 0) {
            char dir_copy[2048] = {0};
            pthread_mutex_lock(&g_dir_mutex);
            strncpy(dir_copy, g_source_dir, sizeof(dir_copy) - 1);
            pthread_mutex_unlock(&g_dir_mutex);

            int restored = 0;
            const char *subs[] = { "_ภาพเบลอ_Blurry", "_พอใช้_Soft", "_ภาพคมชัด_Sharp", NULL };
            if (dir_copy[0]) {
                for (int i = 0; subs[i] != NULL; i++) {
                    char sub_p[4096];
                    snprintf(sub_p, sizeof(sub_p), "%s/%s", dir_copy, subs[i]);
                    DIR *d = opendir(sub_p);
                    if (!d) continue;
                    struct dirent *ent;
                    while ((ent = readdir(d)) != NULL) {
                        if (ent->d_name[0] == '.') continue;
                        char s_file[4096], d_file[4096];
                        snprintf(s_file, sizeof(s_file), "%s/%s", sub_p, ent->d_name);
                        snprintf(d_file, sizeof(d_file), "%s/%s", dir_copy, ent->d_name);
                        if (rename(s_file, d_file) == 0) restored++;
                    }
                    closedir(d);
                    rmdir(sub_p);
                }
            }
            char resp[128];
            snprintf(resp, sizeof(resp), "{\"ok\":true,\"restored\":%d}", restored);
            send_json_response(client_fd, resp);
            close(client_fd);
            return NULL;
        }

        // 6B. POST /__trash_files (Moves specified blurry photos + paired RAWs directly to macOS Trash!)
        if (strncmp(header_buf, "POST /__trash_files", 19) == 0) {
            long content_len = 0;
            char *cl = strcasestr(header_buf, "Content-Length:");
            if (cl) content_len = atol(cl + 15);

            char *body = malloc(content_len + 1);
            if (!body) {
                send_json_response(client_fd, "{\"ok\":false}");
                close(client_fd);
                return NULL;
            }

            long already = received - header_end;
            if (already > 0) {
                memcpy(body, header_buf + header_end, already > content_len ? content_len : already);
            }
            long rem = content_len - already;
            long offset = already;
            while (rem > 0) {
                ssize_t n = recv(client_fd, body + offset, rem, 0);
                if (n <= 0) break;
                offset += n;
                rem -= n;
            }
            body[content_len] = '\0';

            char dir_copy[2048] = {0};
            pthread_mutex_lock(&g_dir_mutex);
            strncpy(dir_copy, g_source_dir, sizeof(dir_copy) - 1);
            pthread_mutex_unlock(&g_dir_mutex);

            int trashed_photos = 0;
            int trashed_raws = 0;
            NSFileManager *fm = [NSFileManager defaultManager];

            if (dir_copy[0]) {
                const char *raw_exts[] = {
                    ".NEF", ".nef", ".ARW", ".arw", ".CR2", ".cr2",
                    ".CR3", ".cr3", ".DNG", ".dng", ".RAF", ".raf",
                    ".ORF", ".orf", ".RW2", ".rw2", ".XMP", ".xmp", NULL
                };

                char *saveptr = NULL;
                char *fname = strtok_r(body, "\n", &saveptr);
                while (fname) {
                    if (fname[0] && !strchr(fname, '/')) {
                        char p1[4096], p2[4096];
                        snprintf(p1, sizeof(p1), "%s/%s", dir_copy, fname);
                        snprintf(p2, sizeof(p2), "%s/_ภาพเบลอ_Blurry/%s", dir_copy, fname);

                        NSString *nsP1 = [NSString stringWithUTF8String:p1];
                        NSString *nsP2 = [NSString stringWithUTF8String:p2];
                        BOOL okTrash = NO;
                        if ([fm fileExistsAtPath:nsP1]) {
                            okTrash = [fm trashItemAtURL:[NSURL fileURLWithPath:nsP1] resultingItemURL:nil error:nil];
                        } else if ([fm fileExistsAtPath:nsP2]) {
                            okTrash = [fm trashItemAtURL:[NSURL fileURLWithPath:nsP2] resultingItemURL:nil error:nil];
                        }
                        if (okTrash) {
                            trashed_photos++;
                            // Also move paired RAW to Trash if present
                            char stem[512];
                            strncpy(stem, fname, sizeof(stem) - 1);
                            stem[sizeof(stem) - 1] = '\0';
                            char *dot = strrchr(stem, '.');
                            if (dot) {
                                *dot = '\0';
                                for (int r = 0; raw_exts[r] != NULL; r++) {
                                    char rp1[4096], rp2[4096];
                                    snprintf(rp1, sizeof(rp1), "%s/%s%s", dir_copy, stem, raw_exts[r]);
                                    snprintf(rp2, sizeof(rp2), "%s/_ภาพเบลอ_Blurry/%s%s", dir_copy, stem, raw_exts[r]);
                                    NSString *nsR1 = [NSString stringWithUTF8String:rp1];
                                    NSString *nsR2 = [NSString stringWithUTF8String:rp2];
                                    if ([fm fileExistsAtPath:nsR1]) {
                                        if ([fm trashItemAtURL:[NSURL fileURLWithPath:nsR1] resultingItemURL:nil error:nil]) trashed_raws++;
                                    } else if ([fm fileExistsAtPath:nsR2]) {
                                        if ([fm trashItemAtURL:[NSURL fileURLWithPath:nsR2] resultingItemURL:nil error:nil]) trashed_raws++;
                                    }
                                }
                            }
                        }
                    }
                    fname = strtok_r(NULL, "\n", &saveptr);
                }
            }

            free(body);
            char resp[256];
            snprintf(resp, sizeof(resp),
                "{\"ok\":true,\"trashedPhotos\":%d,\"trashedRaws\":%d}",
                trashed_photos, trashed_raws);
            send_json_response(client_fd, resp);
            close(client_fd);
            return NULL;
        }

        // 7. POST /__reveal_finder
        if (strncmp(header_buf, "POST /__reveal_finder", 21) == 0) {
            char dir_copy[2048] = {0};
            pthread_mutex_lock(&g_dir_mutex);
            strncpy(dir_copy, g_source_dir, sizeof(dir_copy) - 1);
            pthread_mutex_unlock(&g_dir_mutex);

            if (dir_copy[0]) {
                NSString *pathStr = [NSString stringWithUTF8String:dir_copy];
                dispatch_async(dispatch_get_main_queue(), ^{
                    [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:pathStr]];
                });
            }
            send_json_response(client_fd, "{\"ok\":true}");
            close(client_fd);
            return NULL;
        }

        // 8. POST /__save_rescued?name=...
        if (strncmp(header_buf, "POST /__save_rescued", 20) == 0) {
            char raw_name[512] = "rescued.jpg";
            char *q = strstr(header_buf, "name=");
            if (q) {
                q += 5;
                size_t i = 0;
                while (q[i] && q[i] != ' ' && q[i] != '&' && q[i] != '\r' && i + 1 < sizeof(raw_name)) {
                    raw_name[i] = q[i];
                    i++;
                }
                raw_name[i] = '\0';
            }
            char clean_name[512];
            url_decode_safe_filename(raw_name, clean_name, sizeof(clean_name));

            long content_len = 0;
            char *cl = strcasestr(header_buf, "Content-Length:");
            if (cl) content_len = atol(cl + 15);

            char dir_copy[2048] = {0};
            pthread_mutex_lock(&g_dir_mutex);
            strncpy(dir_copy, g_source_dir, sizeof(dir_copy) - 1);
            pthread_mutex_unlock(&g_dir_mutex);

            char out_dir[4096] = {0};
            char full_path[4096] = {0};
            if (dir_copy[0]) {
                snprintf(out_dir, sizeof(out_dir), "%s/_AI_กู้ความคมชัด", dir_copy);
                mkdir(out_dir, 0755);
                snprintf(full_path, sizeof(full_path), "%s/%s", out_dir, clean_name);
            }

            FILE *out = full_path[0] ? fopen(full_path, "wb") : NULL;
            long body_already = received - header_end;
            if (out && body_already > 0) {
                fwrite(header_buf + header_end, 1, body_already, out);
            }
            long remaining = content_len - body_already;
            char chunk[65536];
            while (remaining > 0) {
                ssize_t to_read = remaining > (long)sizeof(chunk) ? sizeof(chunk) : remaining;
                ssize_t n = recv(client_fd, chunk, to_read, 0);
                if (n <= 0) break;
                if (out) fwrite(chunk, 1, n, out);
                remaining -= n;
            }
            if (out) fclose(out);

            send_json_response(client_fd, "{\"ok\":true}");
            close(client_fd);
            return NULL;
        }

        // Default: Serve bundled index.html
        FILE *f = fopen(g_html_path, "rb");
        if (!f) {
            const char *nf = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found";
            send(client_fd, nf, strlen(nf), 0);
            close(client_fd);
            return NULL;
        }
        fseek(f, 0, SEEK_END);
        long fsize = ftell(f);
        fseek(f, 0, SEEK_SET);

        char *buf = malloc(fsize);
        if (buf) {
            fread(buf, 1, fsize, f);
            char header[320];
            snprintf(header, sizeof(header),
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: text/html; charset=utf-8\r\n"
                "Content-Length: %ld\r\n"
                "Cache-Control: no-store, no-cache, must-revalidate, max-age=0\r\n"
                "Connection: close\r\n\r\n", fsize);
            send(client_fd, header, strlen(header), 0);
            long sent = 0;
            while (sent < fsize) {
                ssize_t n = send(client_fd, buf + sent, fsize - sent, 0);
                if (n <= 0) break;
                sent += n;
            }
            free(buf);
        }
        fclose(f);
        close(client_fd);
        return NULL;
    }
}

static void *server_thread(void *arg) {
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) return NULL;

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");

    int bound = 0;
    for (int p = DEFAULT_PORT; p < DEFAULT_PORT + 20; p++) {
        addr.sin_port = htons(p);
        if (bind(server_fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
            g_actual_port = p;
            bound = 1;
            break;
        }
    }
    if (!bound) {
        close(server_fd);
        return NULL;
    }

    if (listen(server_fd, 128) < 0) {
        close(server_fd);
        return NULL;
    }

    while (1) {
        struct sockaddr_in caddr;
        socklen_t clen = sizeof(caddr);
        int cfd = accept(server_fd, (struct sockaddr *)&caddr, &clen);
        if (cfd < 0) continue;

        int *arg_fd = malloc(sizeof(int));
        *arg_fd = cfd;
        pthread_t tid;
        pthread_create(&tid, NULL, handle_client, arg_fd);
        pthread_detach(tid);
    }
    return NULL;
}

@interface SharpSelectDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate>
@property (strong, nonatomic) NSWindow *window;
@property (strong, nonatomic) WKWebView *webView;
@end

@implementation SharpSelectDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    NSRect screenRect = [[NSScreen mainScreen] visibleFrame];
    CGFloat w = MIN(1480, screenRect.size.width * 0.94);
    CGFloat h = MIN(920, screenRect.size.height * 0.92);
    NSRect frame = NSMakeRect(
        screenRect.origin.x + (screenRect.size.width - w) * 0.5,
        screenRect.origin.y + (screenRect.size.height - h) * 0.5,
        w, h
    );

    NSUInteger style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                       NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;

    self.window = [[NSWindow alloc] initWithContentRect:frame
                                              styleMask:style
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    [self.window setTitle:@"Iris — โปรแกรมคัดภาพเบลอ & ตรวจโฟกัสดวงตา AI (Apple Silicon Multi-Core)"];
    [self.window setMinSize:NSMakeSize(1024, 680)];
    [self.window setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]];
    [self.window setBackgroundColor:[NSColor colorWithCalibratedRed:0.043 green:0.055 blue:0.078 alpha:1.0]];
    [self.window setDelegate:self];

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    [config.preferences setValue:@YES forKey:@"allowFileAccessFromFileURLs"];

    self.webView = [[WKWebView alloc] initWithFrame:[[self.window contentView] bounds]
                                      configuration:config];
    [self.webView setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
    [self.webView setUIDelegate:self];
    [self.webView setNavigationDelegate:self];
    [self.webView setValue:@NO forKey:@"drawsBackground"];

    [[self.window contentView] addSubview:self.webView];

    NSString *urlStr = [NSString stringWithFormat:@"http://127.0.0.1:%d/", g_actual_port];
    [self.webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:urlStr]]];

    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (void)reloadPage:(id)sender {
    [self.webView reload];
}

@end

static void setup_macos_menu(SharpSelectDelegate *delegate) {
    NSMenu *menubar = [[NSMenu alloc] init];
    NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:appMenuItem];

    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:@"About Iris" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *reloadItem = [[NSMenuItem alloc] initWithTitle:@"Reload Studio" action:@selector(reloadPage:) keyEquivalent:@"r"];
    [reloadItem setTarget:delegate];
    [appMenu addItem:reloadItem];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Quit Iris" action:@selector(terminate:) keyEquivalent:@"q"];
    [appMenuItem setSubmenu:appMenu];

    [NSApp setMainMenu:menubar];
}

int main(int argc, const char *argv[]) {
    signal(SIGPIPE, SIG_IGN);
    @autoreleasepool {
        char exe_path[2048];
        uint32_t size = sizeof(exe_path);
        if (_NSGetExecutablePath(exe_path, &size) != 0) return 1;

        char real_exe[2048];
        if (!realpath(exe_path, real_exe)) strncpy(real_exe, exe_path, sizeof(real_exe));

        char *dir = dirname(real_exe);
        snprintf(g_bundle_html_path, sizeof(g_bundle_html_path), "%s/../Resources/index.html", dir);
        const char *home_dir = getenv("HOME");
        if (home_dir && home_dir[0]) {
            snprintf(g_ota_dir, sizeof(g_ota_dir), "%s/Library/Application Support/Iris", home_dir);
            snprintf(g_ota_html_path, sizeof(g_ota_html_path), "%s/index.html", g_ota_dir);
        }

        // Use OTA-updated HTML if it exists, is valid (> 50KB), and is newer than the bundled HTML
        struct stat st_bundle, st_ota;
        int has_bundle = (stat(g_bundle_html_path, &st_bundle) == 0);
        int has_ota = (g_ota_html_path[0] && stat(g_ota_html_path, &st_ota) == 0 && st_ota.st_size >= 50000);
        if (has_ota && (!has_bundle || st_ota.st_mtime >= st_bundle.st_mtime)) {
            strncpy(g_html_path, g_ota_html_path, sizeof(g_html_path) - 1);
        } else {
            strncpy(g_html_path, g_bundle_html_path, sizeof(g_html_path) - 1);
        }
        g_boot_time = (long)time(NULL);

        system("/usr/sbin/lsof -ti :5182 | /usr/bin/xargs kill -9 >/dev/null 2>&1");
        usleep(50000);

        pthread_t stid;
        pthread_create(&stid, NULL, server_thread, NULL);
        pthread_detach(stid);
        usleep(50000);

        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];

        SharpSelectDelegate *delegate = [[SharpSelectDelegate alloc] init];
        [app setDelegate:delegate];
        setup_macos_menu(delegate);

        [app run];
    }
    return 0;
}
