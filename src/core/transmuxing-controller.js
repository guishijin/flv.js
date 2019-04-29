/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import EventEmitter from 'events';
import Log from '../utils/logger.js';
import Browser from '../utils/browser.js';
import MediaInfo from './media-info.js';
import FLVDemuxer from '../demux/flv-demuxer.js';
import MP4Remuxer from '../remux/mp4-remuxer.js';
import DemuxErrors from '../demux/demux-errors.js';
import IOController from '../io/io-controller.js';
import TransmuxingEvents from './transmuxing-events.js';
import {LoaderStatus, LoaderErrors} from '../io/loader.js';

// Transmuxing (IO, Demuxing, Remuxing) controller, with multipart support
/**
 * 转封装器控制器类
 */
class TransmuxingController {

    /**
     * 构造函数
     * @param {mediaDataSource对象} mediaDataSource 
     * @param {可选的配置对象} config 
     */
    constructor(mediaDataSource, config) {
        // 初始化TAG
        this.TAG = 'TransmuxingController';
        // 初始化事件发射器
        this._emitter = new EventEmitter();

        // 保存配置对象
        this._config = config;

        // 将单片的媒体看做多片的媒体统一处理
        // treat single part media as multipart media, which has only one segment
        if (!mediaDataSource.segments) {
            mediaDataSource.segments = [{
                duration: mediaDataSource.duration,
                filesize: mediaDataSource.filesize,
                url: mediaDataSource.url
            }];
        }

        // fill in default IO params if not exists
        if (typeof mediaDataSource.cors !== 'boolean') {
            mediaDataSource.cors = true;
        }
        if (typeof mediaDataSource.withCredentials !== 'boolean') {
            mediaDataSource.withCredentials = false;
        }

        // 保存mediaDataSource对象
        this._mediaDataSource = mediaDataSource;
        // 初始化单签的分片索引为0
        this._currentSegmentIndex = 0;
        let totalDuration = 0;

        // 初始化所有的segment
        this._mediaDataSource.segments.forEach((segment) => {
            // timestampBase for each segment, and calculate total duration
            segment.timestampBase = totalDuration;
            totalDuration += segment.duration;
            // params needed by IOController
            segment.cors = mediaDataSource.cors;
            segment.withCredentials = mediaDataSource.withCredentials;
            // referrer policy control, if exist
            if (config.referrerPolicy) {
                segment.referrerPolicy = config.referrerPolicy;
            }
        });

        if (!isNaN(totalDuration) && this._mediaDataSource.duration !== totalDuration) {
            this._mediaDataSource.duration = totalDuration;
        }

        this._mediaInfo = null;
        this._demuxer = null;
        this._remuxer = null;
        this._ioctl = null;

        this._pendingSeekTime = null;
        this._pendingResolveSeekPoint = null;

        this._statisticsReporter = null;
    }

    /**
     * 析构函数
     */
    destroy() {
        this._mediaInfo = null;
        this._mediaDataSource = null;

        if (this._statisticsReporter) {
            this._disableStatisticsReporter();
        }
        if (this._ioctl) {
            this._ioctl.destroy();
            this._ioctl = null;
        }
        if (this._demuxer) {
            this._demuxer.destroy();
            this._demuxer = null;
        }
        if (this._remuxer) {
            this._remuxer.destroy();
            this._remuxer = null;
        }

        this._emitter.removeAllListeners();
        this._emitter = null;
    }

    /**
     * 添加事件监听器
     * @param {事件} event 
     * @param {监听器} listener 
     */
    on(event, listener) {
        this._emitter.addListener(event, listener);
    }

    /**
     * 移除事件监听器
     * @param {事件} event 
     * @param {*监听器} listener 
     */
    off(event, listener) {
        this._emitter.removeListener(event, listener);
    }

    /**
     * 启动转封装器控制器
     */
    start() {
        // 加载第0个分片
        this._loadSegment(0);
        // 使能状态统计报告
        this._enableStatisticsReporter();
    }

    /**
     * 加载分片
     * @param {分片索引} segmentIndex 
     * @param {可选的optionFrom参数} optionalFrom 
     */
    _loadSegment(segmentIndex, optionalFrom) {
        this._currentSegmentIndex = segmentIndex;
        let dataSource = this._mediaDataSource.segments[segmentIndex];

        // 初始化IOController控制器对象ioctl
        let ioctl = this._ioctl = new IOController(dataSource, this._config, segmentIndex);
        ioctl.onError = this._onIOException.bind(this);
        ioctl.onSeeked = this._onIOSeeked.bind(this);
        ioctl.onComplete = this._onIOComplete.bind(this);
        ioctl.onRedirect = this._onIORedirect.bind(this);
        ioctl.onRecoveredEarlyEof = this._onIORecoveredEarlyEof.bind(this);

        if (optionalFrom) {
            this._demuxer.bindDataSource(this._ioctl);
        } else {
            ioctl.onDataArrival = this._onInitChunkArrival.bind(this);
        }

        // 打开ioctl
        ioctl.open(optionalFrom);
    }

    /**
     * 停止转封装器控制器
     */
    stop() {
        this._internalAbort();
        this._disableStatisticsReporter();
    }

    _internalAbort() {
        if (this._ioctl) {
            this._ioctl.destroy();
            this._ioctl = null;
        }
    }

    /**
     * pause操作
     */
    pause() {  // take a rest
        if (this._ioctl && this._ioctl.isWorking()) {
            this._ioctl.pause();
            this._disableStatisticsReporter();
        }
    }

    /**
     * resume操作
     */
    resume() {
        if (this._ioctl && this._ioctl.isPaused()) {
            this._ioctl.resume();
            this._enableStatisticsReporter();
        }
    }

    /**
     * seek操作
     * @param {毫秒} milliseconds 
     */
    seek(milliseconds) {
        if (this._mediaInfo == null || !this._mediaInfo.isSeekable()) {
            return;
        }

        let targetSegmentIndex = this._searchSegmentIndexContains(milliseconds);

        if (targetSegmentIndex === this._currentSegmentIndex) {
            // intra-segment seeking
            let segmentInfo = this._mediaInfo.segments[targetSegmentIndex];

            if (segmentInfo == undefined) {
                // current segment loading started, but mediainfo hasn't received yet
                // wait for the metadata loaded, then seek to expected position
                this._pendingSeekTime = milliseconds;
            } else {
                let keyframe = segmentInfo.getNearestKeyframe(milliseconds);
                this._remuxer.seek(keyframe.milliseconds);
                this._ioctl.seek(keyframe.fileposition);
                // Will be resolved in _onRemuxerMediaSegmentArrival()
                this._pendingResolveSeekPoint = keyframe.milliseconds;
            }
        } else {
            // cross-segment seeking
            let targetSegmentInfo = this._mediaInfo.segments[targetSegmentIndex];

            if (targetSegmentInfo == undefined) {
                // target segment hasn't been loaded. We need metadata then seek to expected time
                this._pendingSeekTime = milliseconds;
                this._internalAbort();
                this._remuxer.seek();
                this._remuxer.insertDiscontinuity();
                this._loadSegment(targetSegmentIndex);
                // Here we wait for the metadata loaded, then seek to expected position
            } else {
                // We have target segment's metadata, direct seek to target position
                let keyframe = targetSegmentInfo.getNearestKeyframe(milliseconds);
                this._internalAbort();
                this._remuxer.seek(milliseconds);
                this._remuxer.insertDiscontinuity();
                this._demuxer.resetMediaInfo();
                this._demuxer.timestampBase = this._mediaDataSource.segments[targetSegmentIndex].timestampBase;
                this._loadSegment(targetSegmentIndex, keyframe.fileposition);
                this._pendingResolveSeekPoint = keyframe.milliseconds;
                this._reportSegmentMediaInfo(targetSegmentIndex);
            }
        }

        this._enableStatisticsReporter();
    }

    /**
     * 搜索包含指定毫秒的片段
     * @param {毫秒} milliseconds 
     */
    _searchSegmentIndexContains(milliseconds) {
        let segments = this._mediaDataSource.segments;
        let idx = segments.length - 1;

        for (let i = 0; i < segments.length; i++) {
            if (milliseconds < segments[i].timestampBase) {
                idx = i - 1;
                break;
            }
        }
        return idx;
    }

    /**
     * 初始的chunk到达事件处理
     * @param {*} data 
     * @param {*} byteStart 
     */
    _onInitChunkArrival(data, byteStart) {
        let probeData = null;
        let consumed = 0;

        if (byteStart > 0) {
            // IOController seeked immediately after opened, byteStart > 0 callback may received
            this._demuxer.bindDataSource(this._ioctl);
            this._demuxer.timestampBase = this._mediaDataSource.segments[this._currentSegmentIndex].timestampBase;

            consumed = this._demuxer.parseChunks(data, byteStart);
        } else if ((probeData = FLVDemuxer.probe(data)).match) {
            // TODO: flv 系列解析器创建和关联关系绑定
            // Always create new FLVDemuxer
            // 创建新的flv解析器
            this._demuxer = new FLVDemuxer(probeData, this._config);

            // 创建fmp4封装器
            if (!this._remuxer) {
                this._remuxer = new MP4Remuxer(this._config);
            }

            // 获取mediasource
            let mds = this._mediaDataSource;
            if (mds.duration != undefined && !isNaN(mds.duration)) {
                this._demuxer.overridedDuration = mds.duration;
            }
            if (typeof mds.hasAudio === 'boolean') {
                this._demuxer.overridedHasAudio = mds.hasAudio;
            }
            if (typeof mds.hasVideo === 'boolean') {
                this._demuxer.overridedHasVideo = mds.hasVideo;
            }

            // 设置解析器
            this._demuxer.timestampBase = mds.segments[this._currentSegmentIndex].timestampBase;

            this._demuxer.onError = this._onDemuxException.bind(this);
            this._demuxer.onMediaInfo = this._onMediaInfo.bind(this);
            this._demuxer.onMetaDataArrived = this._onMetaDataArrived.bind(this);
            this._demuxer.onScriptDataArrived = this._onScriptDataArrived.bind(this);

            // 设置 解析器-》IO； 封装器-》解析器关联关系
            this._remuxer.bindDataSource(this._demuxer
                         .bindDataSource(this._ioctl
            ));

            // 设置封装器的初始化片段回调和片段封装完毕回调
            this._remuxer.onInitSegment = this._onRemuxerInitSegmentArrival.bind(this);
            this._remuxer.onMediaSegment = this._onRemuxerMediaSegmentArrival.bind(this);

            // 解析器解析数据
            consumed = this._demuxer.parseChunks(data, byteStart);
        } else {
            probeData = null;
            Log.e(this.TAG, 'Non-FLV, Unsupported media type!');
            Promise.resolve().then(() => {
                this._internalAbort();
            });
            this._emitter.emit(TransmuxingEvents.DEMUX_ERROR, DemuxErrors.FORMAT_UNSUPPORTED, 'Non-FLV, Unsupported media type');

            consumed = 0;
        }

        return consumed;
    }

    _onMediaInfo(mediaInfo) {
        if (this._mediaInfo == null) {
            // Store first segment's mediainfo as global mediaInfo
            this._mediaInfo = Object.assign({}, mediaInfo);
            this._mediaInfo.keyframesIndex = null;
            this._mediaInfo.segments = [];
            this._mediaInfo.segmentCount = this._mediaDataSource.segments.length;
            Object.setPrototypeOf(this._mediaInfo, MediaInfo.prototype);
        }

        let segmentInfo = Object.assign({}, mediaInfo);
        Object.setPrototypeOf(segmentInfo, MediaInfo.prototype);
        this._mediaInfo.segments[this._currentSegmentIndex] = segmentInfo;

        // notify mediaInfo update
        this._reportSegmentMediaInfo(this._currentSegmentIndex);

        if (this._pendingSeekTime != null) {
            Promise.resolve().then(() => {
                let target = this._pendingSeekTime;
                this._pendingSeekTime = null;
                this.seek(target);
            });
        }
    }

    _onMetaDataArrived(metadata) {
        this._emitter.emit(TransmuxingEvents.METADATA_ARRIVED, metadata);
    }

    _onScriptDataArrived(data) {
        this._emitter.emit(TransmuxingEvents.SCRIPTDATA_ARRIVED, data);
    }

    _onIOSeeked() {
        this._remuxer.insertDiscontinuity();
    }

    _onIOComplete(extraData) {
        let segmentIndex = extraData;
        let nextSegmentIndex = segmentIndex + 1;

        if (nextSegmentIndex < this._mediaDataSource.segments.length) {
            this._internalAbort();
            this._remuxer.flushStashedSamples();
            this._loadSegment(nextSegmentIndex);
        } else {
            this._remuxer.flushStashedSamples();
            this._emitter.emit(TransmuxingEvents.LOADING_COMPLETE);
            this._disableStatisticsReporter();
        }
    }

    _onIORedirect(redirectedURL) {
        let segmentIndex = this._ioctl.extraData;
        this._mediaDataSource.segments[segmentIndex].redirectedURL = redirectedURL;
    }

    _onIORecoveredEarlyEof() {
        this._emitter.emit(TransmuxingEvents.RECOVERED_EARLY_EOF);
    }

    _onIOException(type, info) {
        Log.e(this.TAG, `IOException: type = ${type}, code = ${info.code}, msg = ${info.msg}`);
        this._emitter.emit(TransmuxingEvents.IO_ERROR, type, info);
        this._disableStatisticsReporter();
    }

    _onDemuxException(type, info) {
        Log.e(this.TAG, `DemuxException: type = ${type}, info = ${info}`);
        this._emitter.emit(TransmuxingEvents.DEMUX_ERROR, type, info);
    }

    _onRemuxerInitSegmentArrival(type, initSegment) {
        this._emitter.emit(TransmuxingEvents.INIT_SEGMENT, type, initSegment);
    }

    /**
     * fmp4片段封装完毕事件回调
     * @param {*} type 音频或者视频数据 
     * @param {*} mediaSegment 
     */
    _onRemuxerMediaSegmentArrival(type, mediaSegment) {
        if (this._pendingSeekTime != null) {
            // Media segments after new-segment cross-seeking should be dropped.
            return;
        }
        this._emitter.emit(TransmuxingEvents.MEDIA_SEGMENT, type, mediaSegment);

        // Resolve pending seekPoint
        if (this._pendingResolveSeekPoint != null && type === 'video') {
            let syncPoints = mediaSegment.info.syncPoints;
            let seekpoint = this._pendingResolveSeekPoint;
            this._pendingResolveSeekPoint = null;

            // Safari: Pass PTS for recommend_seekpoint
            if (Browser.safari && syncPoints.length > 0 && syncPoints[0].originalDts === seekpoint) {
                seekpoint = syncPoints[0].pts;
            }
            // else: use original DTS (keyframe.milliseconds)

            this._emitter.emit(TransmuxingEvents.RECOMMEND_SEEKPOINT, seekpoint);
        }
    }

    _enableStatisticsReporter() {
        if (this._statisticsReporter == null) {
            this._statisticsReporter = self.setInterval(
                this._reportStatisticsInfo.bind(this),
            this._config.statisticsInfoReportInterval);
        }
    }

    _disableStatisticsReporter() {
        if (this._statisticsReporter) {
            self.clearInterval(this._statisticsReporter);
            this._statisticsReporter = null;
        }
    }

    _reportSegmentMediaInfo(segmentIndex) {
        let segmentInfo = this._mediaInfo.segments[segmentIndex];
        let exportInfo = Object.assign({}, segmentInfo);

        exportInfo.duration = this._mediaInfo.duration;
        exportInfo.segmentCount = this._mediaInfo.segmentCount;
        delete exportInfo.segments;
        delete exportInfo.keyframesIndex;

        this._emitter.emit(TransmuxingEvents.MEDIA_INFO, exportInfo);
    }

    _reportStatisticsInfo() {
        let info = {};

        info.url = this._ioctl.currentURL;
        info.hasRedirect = this._ioctl.hasRedirect;
        if (info.hasRedirect) {
            info.redirectedURL = this._ioctl.currentRedirectedURL;
        }

        info.speed = this._ioctl.currentSpeed;
        info.loaderType = this._ioctl.loaderType;
        info.currentSegmentIndex = this._currentSegmentIndex;
        info.totalSegmentCount = this._mediaDataSource.segments.length;

        this._emitter.emit(TransmuxingEvents.STATISTICS_INFO, info);
    }

}

/**
 * 导出转封装器控制器类 - TransmuxingController
 */
export default TransmuxingController;