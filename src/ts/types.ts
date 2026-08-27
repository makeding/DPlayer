import Hls, { HlsConfig } from 'hls.js';
import Mpegts from 'mpegts.js';
import type createTlvDemuxModule from 'tlvdemux';
import FlvJs from 'flv.js';
import * as dashjs from 'dashjs';
import WebTorrent from 'webtorrent';
import * as aribb24js from 'aribb24.js';
import * as aribb62js from 'aribb62.js';

import DPlayer from './player';

export type Lang = 'en' | 'zh-cn' | 'zh-tw' | 'ja' | 'ja-jp';
export type Preload = 'none' | 'metadata' | 'auto';
export type CrossOrigin = 'anonymous' | 'use-credentials' | null;
export type VideoType = 'auto' | 'hls' | 'mpegts' | 'tlv' | 'flv' | 'dash' | 'webtorrent' | 'normal';
export type SubtitleType = 'webvtt' | 'aribb24' | 'aribb62';

export type Events = VideoEvents | PlayerEvents;
export type VideoEvents =
    'abort' |
    'canplay' |
    'canplaythrough' |
    'durationchange' |
    'emptied' |
    'ended' |
    'error' |
    'loadeddata' |
    'loadedmetadata' |
    'loadstart' |
    'mozaudioavailable' |
    'pause' |
    'play' |
    'playing' |
    'progress' |
    'ratechange' |
    'seeked' |
    'seeking' |
    'stalled' |
    'suspend' |
    'timeupdate' |
    'volumechange' |
    'waiting';
export type PlayerEvents =
    'screenshot' |
    'thumbnails_show' |
    'thumbnails_hide' |
    'danmaku_show' |
    'danmaku_hide' |
    'danmaku_clear' |
    'danmaku_load_start' |
    'danmaku_load_end' |
    'danmaku_send' |
    'danmaku_opacity' |
    'contextmenu_show' |
    'contextmenu_hide' |
    'notice_show' |
    'notice_hide' |
    'quality_start' |
    'quality_end' |
    'destroy' |
    'resize' |
    'fullscreen' |
    'fullscreen_cancel' |
    'webfullscreen' |
    'webfullscreen_cancel' |
    'subtitle_show' |
    'subtitle_hide' |
    'subtitle_change' |
    'tlv_ready' |
    'tlv_error' |
    'tlv_playback_damage' |
    'tlv_tracks' |
    'tlv_track_change' |
    'tlv_layer_change' |
    'tlv_mpt_snapshot' |
    'tlv_video_properties' |
    'tlv_output_state' |
    'tlv_caption_data' |
    'tlv_broadcast_clock' |
    'tlv_layout_configuration' |
    'tlv_event_info' |
    'tlv_stream_event' |
    'tlv_viewer_participation' |
    'tlv_application_state' |
    'tlv_application_resource' |
    'tlv_application_resources_reset';

export type DanmakuType = 'top' | 'right' | 'bottom';
export type DanmakuSize = 'big' | 'medium' | 'small';
export type FullscreenType = 'browser' | 'web';

export interface Options {
    /**
     * @description player container
     * @default document.querySelector('.dplayer')
     */
    container?: HTMLElement,

    /**
     * @description enable live mode
     * @default false
     */
    live?: boolean,

    /**
     * @description minimum buffer size for live mode
     * @default 0.8
     */
    liveSyncMinBufferSize?: number,

    /**
     * @description sync video when playing live
     * @default true
     */
    syncWhenPlayingLive?: boolean,

    /**
     * @description enable autoplay
     * @default false
     */
    autoplay?: boolean,

    /**
     * @description player theme color
     * @default '#b7daff'
     */
    theme?: string,

    /**
     * @description enable video loop
     * @default false
     */
    loop?: boolean,

    /**
     * @description player language (values: 'en' | 'zh-cn' | 'zh-tw' | 'ja' | 'ja-jp')
     * @default navigator.language.toLowerCase()
     */
    lang?: Lang | string,

    /**
     * @description enable screenshot, if true, video and video poster must enable Cross-Origin
     * @default false
     */
    screenshot?: boolean,

    /**
     * @description enable picture in picture
     * @default true
     */
    pictureInPicture?: boolean,

    /**
     * @description enable airplay in Safari
     * @default true
     */
    airplay?: boolean,

    /**
     * @description enable hotkey, support FF, FR, volume control, play & pause
     * @default true
     */
    hotkey?: boolean,

    /**
     * @description preload video, support 'none' | 'metadata' | 'auto'
     * @default 'metadata'
     */
    preload?: Preload,

    /**
     * @description video crossOrigin attribute (disable CORS by specifying null)
     * @default null
     */
    crossOrigin?: CrossOrigin,

    /**
     * @description default volume, notice that player will remember user setting, default volume will not work after user set volume themselves
     * @default 1.0
     */
    volume?: number,

    /**
     * @description optional playback speed, or or you can set a custom one
     * @default [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
     */
    playbackSpeed?: number[],

    /**
     * @description showing logo in the top left corner, you can adjust its size and position by CSS
     * @default undefined
     */
    logo?: string,

    /**
     * @description getting and sending danmaku in your way
     * @default defaultApiBackend
     */
    apiBackend?: APIBackend,

    /**
     * @description video information
     */
    video: Video,

    /**
     * @description subtitle information (if not given, subtitle will not show)
     * @default undefined
     */
    subtitle?: Subtitle,

    /**
     * @description danmaku information (if not given, danmaku will not show)
     * @default undefined
     */
    danmaku?: Danmaku,

    /**
     * @description custom contextmenu
     * @default []
     */
    contextmenu?: ContextMenuItem[],

    /**
     * @description custom time markers upon progress bar
     * @default []
     */
    highlight?: HighlightItem[],

    /**
     * @description prevent to play multiple player at the same time, pause other players when this player start play
     * @default false
     */
    mutex?: boolean,

    /**
     * @description plugin options
     */
    pluginOptions?: PluginOptions,
}

export interface APIBackend {
    /**
     * @description read danmaku from API backend
     * @param options API backend read options
     */
    read(options: APIBackendReadOptions): void;

    /**
     * @description send danmaku to API backend
     * @param options API backend send options
     */
    send(options: APIBackendSendOptions): void;
}

export interface Video {
    /**
     * @description video quality
     */
    quality?: VideoQuality[];

    /**
     * @description default video quality (quality name or index)
     */
    defaultQuality?: string | number;

    /**
     * @description video url
     */
    url?: string;

    /**
     * @description video poster
     */
    pic?: string;

    /**
     * @description video thumbnails
     * @example
     * // Simple mode (using all defaults)
     * thumbnails: 'thumbnails.jpg'
     * // or
     * thumbnails: { url: 'thumbnails.jpg' }
     *
     * // Custom layout
     * thumbnails: {
     *   url: 'thumbnails.jpg',
     *   width: 160,
     *   columnCount: 10,
     *   totalCount: 100
     * }
     *
     * // Using interval
     * thumbnails: {
     *   url: 'thumbnails.jpg',
     *   width: 160,
     *   columnCount: 10,
     *   interval: 5  // generate thumbnail every 5 seconds
     * }
     */
    thumbnails?: string | {
        /**
         * @description thumbnails sprite image url
         */
        url: string;

        /**
         * @description interval between thumbnails in seconds (if totalCount is not specified)
         * @note interval and totalCount are mutually exclusive
         */
        interval?: number;

        /**
         * @description total count of thumbnails (if interval is not specified)
         * @default 100
         * @note interval and totalCount are mutually exclusive
         */
        totalCount?: number;

        /**
         * @description width of each thumbnail in pixels
         * @default 160
         */
        width?: number;

        /**
         * @description height of each thumbnail in pixels
         * @default calculated from width with 16:9 aspect ratio
         */
        height?: number;

        /**
         * @description number of thumbnails in a row
         * @default 100
         */
        columnCount?: number;
    };

    /**
     * @description values: 'auto' | 'hls' | 'mpegts' | 'flv' | 'dash' | 'webtorrent' | 'normal' or other custom export type
     */
    type?: VideoType | string;

    /**
     * @description custom video export type implementation
     */
    customType?: {[key: string]: (video: HTMLVideoElement, player: DPlayer) => void};

    /**
     * @description MMT/TLV source information used when type is `tlv`
     */
    tlv?: TLVSourceOptions;
}

export interface VideoQuality {
    /**
     * @description quality name
     */
    name: string;

    /**
     * @description video url
     */
    url: string;

    /**
     * @description values: 'auto' | 'hls' | 'mpegts' | 'flv' | 'dash' | 'webtorrent' | 'normal' or other custom export type
     */
    type?: VideoType | string;

    /**
     * @description MMT/TLV source information used when type is `tlv`
     */
    tlv?: TLVSourceOptions;
}

export interface TLVSourceOptions {
    /** Preferred MMTP video packet_id. The first HEVC track is used when omitted. */
    videoPacketId?: number;
    /** Exact byte size of a recorded source. Avoids an additional size probe. */
    fileSize?: number;
}

export type ToneMappingMode = createTlvDemuxModule.MseToneMappingMode;

export interface TLVOptions {
    /** Additional fetch options. `signal` and Range headers remain player-owned. */
    fetch?: Omit<RequestInit, 'signal' | 'headers'> & {headers?: HeadersInit};
    /** Forward buffer high-water mark. */
    forwardBufferSeconds?: number;
    /** Back buffer retained in SourceBuffer. */
    backBufferSeconds?: number;
}

export type TLVTrackInfo = createTlvDemuxModule.TrackInfo;
export type TLVPlaybackDamage = createTlvDemuxModule.PlaybackDamage;
export type TLVMptSnapshot = createTlvDemuxModule.MptSnapshot;
export type TLVVideoProperties = createTlvDemuxModule.MseVideoProperties;
export interface TLVOutputState {
    generation: bigint;
    connected: boolean;
    hdrMode: number;
    edidValid: boolean;
    hdrSupport: boolean;
    pqEotf: boolean;
    hlgEotf: boolean;
    bt2020: boolean;
    supports4k50_60: boolean;
    colorSpaceMask: number;
    maxDeepColorBits: number;
    maxTmdsClockMhz: number;
    dolbyTunnelSupported: boolean;
    dolbyMetadataPassthrough: boolean;
    dolbyObservedProfile: number | null;
}
export type TLVEventInfo = createTlvDemuxModule.EventInfo;
export type TLVStreamEvent = createTlvDemuxModule.StreamEvent;
/** Layout configuration carried by an MMT LCT descriptor. */
export type TLVLayoutConfiguration = createTlvDemuxModule.LayoutConfiguration;
export interface TLVLayerChange {
    videoTrack: TLVTrackInfo;
    audioTrack: TLVTrackInfo;
    videoPresentationTimeUs: bigint;
    audioPresentationTimeUs: bigint;
}
export interface TLVLayer {
    video: TLVTrackInfo;
    audio: TLVTrackInfo;
}
export interface TLVLayerPair {
    preferred: TLVLayer;
    fallback: TLVLayer | null;
}
export interface TLVViewerParticipationNotification {
    contextId: number;
    sourcePacketId: number;
    eventMessageTag: number;
    dataEventId: number;
    messageGroupId: number;
    version: number;
    currentNext: boolean;
    sectionNumber: number;
    lastSectionNumber: number;
    inputOffset: bigint;
}
export interface TLVCaptionData {
    trackId: bigint;
    packetId: number;
    componentTag: number;
    subtitleType: 0 | 1;
    subtitleOperationMode: number;
    subtitleTimingMode: number | null;
    subtitleDisplayMode: number;
    mpuSequenceNumber: number | null;
    ptsValue: bigint;
    ptsTimescale: number;
    dtsValue: bigint;
    dtsTimescale: number;
    subtitleReferenceStartPtsValue: bigint | null;
    subtitleReferenceStartPtsTimescale: number | null;
    data: Uint8Array;
    subtitleResources: createTlvDemuxModule.SubtitleResource[];
    discontinuity: boolean;
}
export interface TLVPlugin {
    readonly tracks: readonly TLVTrackInfo[];
    layerPair(tracks?: readonly TLVTrackInfo[]): TLVLayerPair | null;
    seek(time: number): Promise<void>;
    selectVideoTrack(packetId: number): void;
    selectAudioTrack(packetId: number): Promise<void>;
    selectLayer(videoPacketId: number, audioPacketId: number): Promise<void>;
    selectAutomaticLayer(): Promise<void>;
    selectSubtitleTrack(packetId: number): void;
    setToneMappingMode(mode: createTlvDemuxModule.MseToneMappingMode): void;
    /** Inject host-provided display EDID; browsers cannot read HDMI EDID directly. */
    setOutputEdid(edid: Uint8Array): void;
    /** Notify the demuxer about the host display connection state. */
    setOutputConnected(connected: boolean): void;
    applicationEntry(contextId: number): string | null;
    applications(): createTlvDemuxModule.ApplicationState[];
    /** Latest media-to-broadcast-clock mapping, including one discovered before listeners attached. */
    broadcastClock(): createTlvDemuxModule.BroadcastClock | null;
    /** Latest LCT layout, including one discovered before listeners attached. */
    layoutConfiguration(): TLVLayoutConfiguration | null;
    applicationResources(contextId?: number): createTlvDemuxModule.ApplicationResourceMetadata[];
    applicationResource(contextId: number, path: string): createTlvDemuxModule.ApplicationResource | null;
    /** Suppress duplicate native rendering for components consumed by a data-broadcast page. */
    setSubtitleSuppressedComponentTags(componentTags: number[]): void;
    /** Show or hide selectable captions without suppressing character superimpose. */
    setSubtitleVisible(visible: boolean): void;
    destroy(): void;
}

export interface Subtitle {
    /**
     * @description subtitle url (if use aribb24, url is not required)
     */
    url?: string;

    /**
     * @description subtitle export type, values: 'webvtt' | 'aribb24' | 'aribb62'
     * @default 'webvtt'
     */
    type?: SubtitleType;

    /**
     * @description subtitle font size (if use aribb24, fontSize is not used)
     * @default '20px'
     */
    fontSize?: string;

    /**
     * @description the distance between the subtitle and player bottom, values like: '10px' '10%' (if use aribb24, bottom is not used)
     * @default '40px'
     */
    bottom?: string;

    /**
     * @description subtitle color (if use aribb24, color is not used)
     * @default '#fff'
     */
    color?: string;
}

export interface Danmaku {
    /**
     * @description danmaku pool id, it must be unique (if use custom api, id is not required)
     */
    id?: string;

    /**
     * @description danmaku api url (if use custom api, api is not required)
     */
    api?: string;

    /**
     * @description back end verification token (if use custom api, token is not required)
     */
    token?: string;

    /**
     * @description danmaku maximum quantity (if use custom api, maximum is not required)
     */
    maximum?: number;

    /**
     * @description additional danmaku api url (if use custom api, addition is not required)
     */
    addition?: string[];

    /**
     * @description danmaku user name
     * @default 'DPlayer'
     */
    user?: string;

    /**
     * @description values like: '10px' '10%' | the distance between the danmaku bottom and player bottom, in order to prevent warding off subtitle
     */
    bottom?: string;

    /**
     * @description display all danmaku even though danmaku overlap, notice that player will remember user setting, default setting will not work after user set it themselves
     * @default false
     */
    unlimited?: boolean;

    /**
     * @description danmaku speed multiplier, the larger the faster
     * @default 1
     */
    speedRate? : number;

    /**
     * @description danmaku font size
     * @default 35
     */
    fontSize?: number;

    /**
     * @description close comment form after send danmaku
     * @default true
     */
    closeCommentFormAfterSend?: boolean;
}

export interface ContextMenuItem {
    text: string;
    link?: string;
    click?: ((player: DPlayer) => void);
}

export interface HighlightItem {
    text: string;
    time: number;
}

export interface PluginOptions {
    hls?: HlsConfig;
    mpegts?: { config?: Mpegts.Config; mediaDataSource?: Mpegts.MediaDataSource; };
    flv?: { config?: FlvJs.Config; mediaDataSource?: FlvJs.MediaDataSource; };
    dash?: dashjs.MediaPlayerSettingClass;
    webtorrent?: WebTorrent.Options;
    aribb24?: aribb24js.CanvasRendererOption & {
        disableSuperimposeRenderer?: boolean;
    }
    aribb62?: aribb62js.B62TTMLRendererOptions;
    tlv?: TLVOptions;
}

// ===== internal types =====

export interface WindowExtend extends Window {
    dashjs?: typeof dashjs;
    flvjs?: typeof FlvJs;
    Hls?: typeof Hls;
    mpegts?: typeof Mpegts;
    WebTorrent?: typeof WebTorrent;
}

export interface OptionsInternal {
    container: HTMLElement,
    live: boolean,
    liveSyncMinBufferSize: number,
    syncWhenPlayingLive: boolean,
    autoplay: boolean,
    theme: string,
    loop: boolean,
    lang: Lang | string,
    screenshot: boolean,
    pictureInPicture: boolean,
    airplay: boolean,
    hotkey: boolean,
    preload: Preload,
    crossOrigin: CrossOrigin,
    volume: number,
    playbackSpeed: number[],
    logo?: string,
    apiBackend: APIBackend,
    video: VideoInternal,
    subtitle?: SubtitleInternal,
    danmaku?: DanmakuInternal,
    contextmenu: ContextMenuItem[],
    highlight?: HighlightItem[],
    mutex: boolean,
    pluginOptions: PluginOptions,
}

export interface VideoInternal {
    quality?: VideoQualityInternal[];
    defaultQuality?: number;
    url?: string;
    pic?: string;
    thumbnails?: {
        url: string;
        interval?: number;
        totalCount: number;
        width: number;
        height: number;
        columnCount: number;
    };
    type: VideoType | string;
    customType?: {[key: string]: (video: HTMLVideoElement, player: DPlayer) => void};
    tlv?: TLVSourceOptions;
}

export interface VideoQualityInternal {
    name: string;
    url: string;
    type: VideoType | string;
    tlv?: TLVSourceOptions;
    tlvDynamicLayer?: {
        role: 'original' | 'preferred' | 'fallback';
        sourceIndex: number;
        videoPacketId?: number;
        audioPacketId?: number;
    };
}

export interface SubtitleInternal {
    url?: string;
    type: SubtitleType;
    fontSize: string;
    bottom: string;
    color: string;
}

export interface DanmakuInternal {
    id?: string;
    api?: string;
    token?: string;
    maximum?: number;
    addition?: string[];
    user: string;
    bottom?: string;
    unlimited?: boolean;
    speedRate : number;
    fontSize: number;
    closeCommentFormAfterSend: boolean;
}

export interface Plugins {
    hls?: Hls;
    mpegts?: Mpegts.Player | Mpegts.MSEPlayer | Mpegts.NativePlayer;
    flvjs?: FlvJs.Player;
    dash?: dashjs.MediaPlayerClass;
    webtorrent?: WebTorrent.Instance;
    aribb24Caption?: aribb24js.CanvasRenderer;
    aribb24Superimpose?: aribb24js.CanvasRenderer;
    aribb62?: {
        overlay: HTMLElement;
        renderer: aribb62js.B62TTMLRenderer;
    };
    tlv?: TLVPlugin;
}

export interface APIBackendReadOptions {
    url?: string;
    success: (danmaku: Dan[]) => void;
    error: (message?: string) => void;
}

export interface APIBackendSendOptions {
    url?: string;
    data: Dan;
    success: () => void;
    error: (message?: string) => void;
}

export interface DanmakuItem {
    text: string;
    color: string;
    type: DanmakuType;
    size: DanmakuSize;
    border?: boolean;
}

export interface Dan {
    token?: string,
    id?: string,
    author?: string,
    time: number,
    text: string;
    color: string;
    type: DanmakuType;
    size: DanmakuSize;
}
