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
import PlayerEvents from './player-events.js';
import Transmuxer from '../core/transmuxer.js';
import TransmuxingEvents from '../core/transmuxing-events.js';
import MSEController from '../core/mse-controller.js';
import MSEEvents from '../core/mse-events.js';
import {ErrorTypes, ErrorDetails} from './player-errors.js';
import {createDefaultConfig} from '../config.js';
import {InvalidArgumentException, IllegalStateException} from '../utils/exception.js';

/**
 * FlvPlayer播放器类使用MediaSourceExtent来进行视频播放
 */
class FlvPlayer {

    /**
     * 构造函数
     * @param {媒体数据源对象} mediaDataSource 
     * @param {可选的配置对象} config 
     */
    constructor(mediaDataSource, config) {
        // 初始化日志TAG
        this.TAG = 'FlvPlayer';
        // 初始化内部属性_type
        this._type = 'FlvPlayer';
        // 初始化播放器事件发射器属性_emitter
        this._emitter = new EventEmitter();

        // 初始化播放器配置属性_config为默认配置
        this._config = createDefaultConfig();
        if (typeof config === 'object') {
            // 使用外部传入的config初始化_config
            Object.assign(this._config, config);
        }

        // 判断传入的mediaDataSource.type为flv，否则抛出异常
        if (mediaDataSource.type.toLowerCase() !== 'flv') {
            throw new InvalidArgumentException('FlvPlayer requires an flv MediaDataSource input!');
        }

        // 检查mediaDataSource.isLive标志，并更新_config.isLive标志
        if (mediaDataSource.isLive === true) {
            this._config.isLive = true;
        }

        // 初始化事件对象e为一系列事件处理函数集合
        this.e = {
            onvLoadedMetadata: this._onvLoadedMetadata.bind(this),
            onvSeeking: this._onvSeeking.bind(this),
            onvCanPlay: this._onvCanPlay.bind(this),
            onvStalled: this._onvStalled.bind(this),
            onvProgress: this._onvProgress.bind(this)
        };

        // 初始化性能统计参数_now
        if (self.performance && self.performance.now) {
            this._now = self.performance.now.bind(self.performance);
        } else {
            this._now = Date.now;
        }

        // 初始化一系列内部属性成员
        this._pendingSeekTime = null;  // in seconds
        this._requestSetTime = false;
        this._seekpointRecord = null;
        this._progressChecker = null;

        // 保存外部传入的mediaDataSource到_mediaDataSource
        this._mediaDataSource = mediaDataSource;
        this._mediaElement = null;
        this._msectl = null;
        this._transmuxer = null;

        this._mseSourceOpened = false;
        this._hasPendingLoad = false;
        this._receivedCanPlay = false;

        this._mediaInfo = null;
        this._statisticsInfo = null;

        let chromeNeedIDRFix = (Browser.chrome &&
                               (Browser.version.major < 50 ||
                               (Browser.version.major === 50 && Browser.version.build < 2661)));
        this._alwaysSeekKeyframe = (chromeNeedIDRFix || Browser.msedge || Browser.msie) ? true : false;

        if (this._alwaysSeekKeyframe) {
            this._config.accurateSeek = false;
        }

        // 初始化完成
    }

    /**
     * 析构函数
     */
    destroy() {
        if (this._progressChecker != null) {
            window.clearInterval(this._progressChecker);
            this._progressChecker = null;
        }
        if (this._transmuxer) {
            this.unload();
        }
        if (this._mediaElement) {
            this.detachMediaElement();
        }
        this.e = null;
        this._mediaDataSource = null;

        this._emitter.removeAllListeners();
        this._emitter = null;
    }

    /**
     * 给播放器安装指定的事件监听器
     * @param {事件名称-PlayerEvents枚举类型} event 
     * @param {事件监听器} listener 
     */
    on(event, listener) {
        if (event === PlayerEvents.MEDIA_INFO) {
            if (this._mediaInfo != null) {
                Promise.resolve().then(() => {
                    this._emitter.emit(PlayerEvents.MEDIA_INFO, this.mediaInfo);
                });
            }
        } else if (event === PlayerEvents.STATISTICS_INFO) {
            if (this._statisticsInfo != null) {
                Promise.resolve().then(() => {
                    this._emitter.emit(PlayerEvents.STATISTICS_INFO, this.statisticsInfo);
                });
            }
        }

        // 安装事件监听器
        this._emitter.addListener(event, listener);
    }

    /**
     * 从播放器移除指定的事件监听器
     * @param {事件名称-PlayerEvents枚举类型} event 
     * @param {事件监听器} listener 
     */
    off(event, listener) {
        this._emitter.removeListener(event, listener);
    }

    /**
     * 附加HtmlMediaElement -- video标签元素
     * @param {HTMLMediaElement} mediaElement 
     */
    attachMediaElement(mediaElement) {
        // 保存video标签元素
        this._mediaElement = mediaElement;
        // 添加video标签的事件监听器
        mediaElement.addEventListener('loadedmetadata', this.e.onvLoadedMetadata);
        mediaElement.addEventListener('seeking', this.e.onvSeeking);
        mediaElement.addEventListener('canplay', this.e.onvCanPlay);
        mediaElement.addEventListener('stalled', this.e.onvStalled);
        mediaElement.addEventListener('progress', this.e.onvProgress);

        // 初始化MSEController对象
        this._msectl = new MSEController(this._config);

        // 添加MSE的事件监听器
        this._msectl.on(MSEEvents.UPDATE_END, this._onmseUpdateEnd.bind(this));
        this._msectl.on(MSEEvents.BUFFER_FULL, this._onmseBufferFull.bind(this));
        this._msectl.on(MSEEvents.SOURCE_OPEN, () => {
            this._mseSourceOpened = true;
            if (this._hasPendingLoad) {
                this._hasPendingLoad = false;

                // 自动加载
                this.load();
            }
        });
        this._msectl.on(MSEEvents.ERROR, (info) => {
            this._emitter.emit(PlayerEvents.ERROR,
                               ErrorTypes.MEDIA_ERROR,
                               ErrorDetails.MEDIA_MSE_ERROR,
                               info
            );
        });

        // MSE对象附加HtmlMediaElement-video标签对象
        this._msectl.attachMediaElement(mediaElement);

        if (this._pendingSeekTime != null) {
            try {
                mediaElement.currentTime = this._pendingSeekTime;
                this._pendingSeekTime = null;
            } catch (e) {
                // IE11 may throw InvalidStateError if readyState === 0
                // We can defer set currentTime operation after loadedmetadata
            }
        }
    }

    /**
     * 分离媒体元素
     */
    detachMediaElement() {
        if (this._mediaElement) {
            // mse分离媒体元素
            this._msectl.detachMediaElement();
            // mse移除事件监听器
            this._mediaElement.removeEventListener('loadedmetadata', this.e.onvLoadedMetadata);
            this._mediaElement.removeEventListener('seeking', this.e.onvSeeking);
            this._mediaElement.removeEventListener('canplay', this.e.onvCanPlay);
            this._mediaElement.removeEventListener('stalled', this.e.onvStalled);
            this._mediaElement.removeEventListener('progress', this.e.onvProgress);
            this._mediaElement = null;
        }
        if (this._msectl) {
            // 销毁mse
            this._msectl.destroy();
            this._msectl = null;
        }
    }

    /**
     * 加载运行
     */
    load() {
        if (!this._mediaElement) {
            throw new IllegalStateException('HTMLMediaElement must be attached before load()!');
        }
        if (this._transmuxer) {
            throw new IllegalStateException('FlvPlayer.load() has been called, please call unload() first!');
        }
        if (this._hasPendingLoad) {
            return;
        }

        if (this._config.deferLoadAfterSourceOpen && this._mseSourceOpened === false) {
            this._hasPendingLoad = true;
            return;
        }

        if (this._mediaElement.readyState > 0) {
            this._requestSetTime = true;
            // IE11 may throw InvalidStateError if readyState === 0
            this._mediaElement.currentTime = 0;
        }

        // 初始化转封装器Transmuxer
        this._transmuxer = new Transmuxer(this._mediaDataSource, this._config);

        // 转封装器添加事件监听器
        // 初始的分片
        this._transmuxer.on(TransmuxingEvents.INIT_SEGMENT, (type, is) => {
            this._msectl.appendInitSegment(is);
        });
        // 媒体分片
        this._transmuxer.on(TransmuxingEvents.MEDIA_SEGMENT, (type, ms) => {
            
            // 将媒体分片附加到mse控制器
            this._msectl.appendMediaSegment(ms);

            // lazyLoad check
            if (this._config.lazyLoad && !this._config.isLive) {
                let currentTime = this._mediaElement.currentTime;
                if (ms.info.endDts >= (currentTime + this._config.lazyLoadMaxDuration) * 1000) {
                    if (this._progressChecker == null) {
                        Log.v(this.TAG, 'Maximum buffering duration exceeded, suspend transmuxing task');
                        this._suspendTransmuxer();
                    }
                }
            }
        });
        this._transmuxer.on(TransmuxingEvents.LOADING_COMPLETE, () => {
            this._msectl.endOfStream();
            this._emitter.emit(PlayerEvents.LOADING_COMPLETE);
        });
        this._transmuxer.on(TransmuxingEvents.RECOVERED_EARLY_EOF, () => {
            this._emitter.emit(PlayerEvents.RECOVERED_EARLY_EOF);
        });
        this._transmuxer.on(TransmuxingEvents.IO_ERROR, (detail, info) => {
            this._emitter.emit(PlayerEvents.ERROR, ErrorTypes.NETWORK_ERROR, detail, info);
        });
        this._transmuxer.on(TransmuxingEvents.DEMUX_ERROR, (detail, info) => {
            this._emitter.emit(PlayerEvents.ERROR, ErrorTypes.MEDIA_ERROR, detail, {code: -1, msg: info});
        });
        this._transmuxer.on(TransmuxingEvents.MEDIA_INFO, (mediaInfo) => {
            this._mediaInfo = mediaInfo;
            this._emitter.emit(PlayerEvents.MEDIA_INFO, Object.assign({}, mediaInfo));
        });
        this._transmuxer.on(TransmuxingEvents.METADATA_ARRIVED, (metadata) => {
            this._emitter.emit(PlayerEvents.METADATA_ARRIVED, metadata);
        });
        this._transmuxer.on(TransmuxingEvents.SCRIPTDATA_ARRIVED, (data) => {
            this._emitter.emit(PlayerEvents.SCRIPTDATA_ARRIVED, data);
        });
        this._transmuxer.on(TransmuxingEvents.STATISTICS_INFO, (statInfo) => {
            this._statisticsInfo = this._fillStatisticsInfo(statInfo);
            this._emitter.emit(PlayerEvents.STATISTICS_INFO, Object.assign({}, this._statisticsInfo));
        });
        this._transmuxer.on(TransmuxingEvents.RECOMMEND_SEEKPOINT, (milliseconds) => {
            if (this._mediaElement && !this._config.accurateSeek) {
                this._requestSetTime = true;
                this._mediaElement.currentTime = milliseconds / 1000;
            }
        });

        // 打开转封装器
        this._transmuxer.open();
    }

    /**
     * 卸载，停止运行
     */
    unload() {
        if (this._mediaElement) {
            // 暂停播放
            this._mediaElement.pause();
        }
        if (this._msectl) {
            // seek到0
            this._msectl.seek(0);
        }
        if (this._transmuxer) {
            // 关闭转封装器
            this._transmuxer.close();
            // 销毁转封装器
            this._transmuxer.destroy();
            this._transmuxer = null;
        }
    }

    /**
     * 开始播放  -- 直接调用video标签的play方法
     */
    play() {
        return this._mediaElement.play();
    }

    /**
     * 暂停播放  -- 直接调用video标签的pause方法
     */
    pause() {
        this._mediaElement.pause();
    }

    /**
     * 获取播放器类型
     */
    get type() {
        return this._type;
    }

    /**
     * 获取video标签的buffered属性
     */
    get buffered() {
        return this._mediaElement.buffered;
    }

    /**
     * 获取video标签的duration属性
     */
    get duration() {
        return this._mediaElement.duration;
    }

    /**
     * 获取video标签的volum属性
     */
    get volume() {
        return this._mediaElement.volume;
    }

    /**
     * 设置video标签的volume属性
     */
    set volume(value) {
        this._mediaElement.volume = value;
    }

    /**
     * 获取video标签的静音muted属性
     */
    get muted() {
        return this._mediaElement.muted;
    }

    /**
     * 设置video标签的muted属性
     */
    set muted(muted) {
        this._mediaElement.muted = muted;
    }

    /**
     * 获取video标签的currentTime属性
     */
    get currentTime() {
        if (this._mediaElement) {
            return this._mediaElement.currentTime;
        }
        return 0;
    }

    /**
     * 设置seek播放
     */
    set currentTime(seconds) {
        if (this._mediaElement) {
            this._internalSeek(seconds);
        } else {
            this._pendingSeekTime = seconds;
        }
    }

    /**
     * 获取媒体信息
     */
    get mediaInfo() {
        return Object.assign({}, this._mediaInfo);
    }

    /**
     * 获取状态统计信息
     */
    get statisticsInfo() {
        if (this._statisticsInfo == null) {
            this._statisticsInfo = {};
        }
        this._statisticsInfo = this._fillStatisticsInfo(this._statisticsInfo);
        return Object.assign({}, this._statisticsInfo);
    }

    /**
     * 填充状态统计信息
     * @param {状态统计信息} statInfo 
     */
    _fillStatisticsInfo(statInfo) {
        statInfo.playerType = this._type;

        if (!(this._mediaElement instanceof HTMLVideoElement)) {
            return statInfo;
        }

        let hasQualityInfo = true;
        let decoded = 0;
        let dropped = 0;

        if (this._mediaElement.getVideoPlaybackQuality) {
            let quality = this._mediaElement.getVideoPlaybackQuality();
            decoded = quality.totalVideoFrames;
            dropped = quality.droppedVideoFrames;
        } else if (this._mediaElement.webkitDecodedFrameCount != undefined) {
            decoded = this._mediaElement.webkitDecodedFrameCount;
            dropped = this._mediaElement.webkitDroppedFrameCount;
        } else {
            hasQualityInfo = false;
        }

        if (hasQualityInfo) {
            statInfo.decodedFrames = decoded;
            statInfo.droppedFrames = dropped;
        }

        return statInfo;
    }

    /**
     * 事件监听器
     */
    _onmseUpdateEnd() {
        if (!this._config.lazyLoad || this._config.isLive) {
            return;
        }

        let buffered = this._mediaElement.buffered;
        let currentTime = this._mediaElement.currentTime;
        let currentRangeStart = 0;
        let currentRangeEnd = 0;

        for (let i = 0; i < buffered.length; i++) {
            let start = buffered.start(i);
            let end = buffered.end(i);
            if (start <= currentTime && currentTime < end) {
                currentRangeStart = start;
                currentRangeEnd = end;
                break;
            }
        }

        if (currentRangeEnd >= currentTime + this._config.lazyLoadMaxDuration && this._progressChecker == null) {
            Log.v(this.TAG, 'Maximum buffering duration exceeded, suspend transmuxing task');
            this._suspendTransmuxer();
        }
    }

    /**
     * 事件监听器
     */
    _onmseBufferFull() {
        Log.v(this.TAG, 'MSE SourceBuffer is full, suspend transmuxing task');
        if (this._progressChecker == null) {
            this._suspendTransmuxer();
        }
    }
  
    /**
     * 挂起转封装器
     */
    _suspendTransmuxer() {
        if (this._transmuxer) {
            this._transmuxer.pause();

            if (this._progressChecker == null) {
                this._progressChecker = window.setInterval(this._checkProgressAndResume.bind(this), 1000);
            }
        }
    }

    /**
     * 检查进度并恢复
     */
    _checkProgressAndResume() {
        let currentTime = this._mediaElement.currentTime;
        let buffered = this._mediaElement.buffered;

        let needResume = false;

        for (let i = 0; i < buffered.length; i++) {
            let from = buffered.start(i);
            let to = buffered.end(i);
            if (currentTime >= from && currentTime < to) {
                if (currentTime >= to - this._config.lazyLoadRecoverDuration) {
                    needResume = true;
                }
                break;
            }
        }

        if (needResume) {
            window.clearInterval(this._progressChecker);
            this._progressChecker = null;
            if (needResume) {
                Log.v(this.TAG, 'Continue loading from paused position');
                this._transmuxer.resume();
            }
        }
    }

    /**
     * 检查是否已经缓存
     * @param {秒} seconds 
     */
    _isTimepointBuffered(seconds) {
        let buffered = this._mediaElement.buffered;

        for (let i = 0; i < buffered.length; i++) {
            let from = buffered.start(i);
            let to = buffered.end(i);
            if (seconds >= from && seconds < to) {
                return true;
            }
        }
        return false;
    }

    /**
     * 内部seek到指定秒
     * @param {秒} seconds 
     */
    _internalSeek(seconds) {
        let directSeek = this._isTimepointBuffered(seconds);

        let directSeekBegin = false;
        let directSeekBeginTime = 0;

        if (seconds < 1.0 && this._mediaElement.buffered.length > 0) {
            let videoBeginTime = this._mediaElement.buffered.start(0);
            if ((videoBeginTime < 1.0 && seconds < videoBeginTime) || Browser.safari) {
                directSeekBegin = true;
                // also workaround for Safari: Seek to 0 may cause video stuck, use 0.1 to avoid
                directSeekBeginTime = Browser.safari ? 0.1 : videoBeginTime;
            }
        }

        if (directSeekBegin) {  // seek to video begin, set currentTime directly if beginPTS buffered
            this._requestSetTime = true;
            this._mediaElement.currentTime = directSeekBeginTime;
        }  else if (directSeek) {  // buffered position
            if (!this._alwaysSeekKeyframe) {
                this._requestSetTime = true;
                this._mediaElement.currentTime = seconds;
            } else {
                let idr = this._msectl.getNearestKeyframe(Math.floor(seconds * 1000));
                this._requestSetTime = true;
                if (idr != null) {
                    this._mediaElement.currentTime = idr.dts / 1000;
                } else {
                    this._mediaElement.currentTime = seconds;
                }
            }
            if (this._progressChecker != null) {
                this._checkProgressAndResume();
            }
        } else {
            if (this._progressChecker != null) {
                window.clearInterval(this._progressChecker);
                this._progressChecker = null;
            }
            this._msectl.seek(seconds);
            this._transmuxer.seek(Math.floor(seconds * 1000));  // in milliseconds
            // no need to set mediaElement.currentTime if non-accurateSeek,
            // just wait for the recommend_seekpoint callback
            if (this._config.accurateSeek) {
                this._requestSetTime = true;
                this._mediaElement.currentTime = seconds;
            }
        }
    }

    /**
     * 检查并应用未缓存的seek点
     */
    _checkAndApplyUnbufferedSeekpoint() {
        if (this._seekpointRecord) {
            if (this._seekpointRecord.recordTime <= this._now() - 100) {
                let target = this._mediaElement.currentTime;
                this._seekpointRecord = null;
                if (!this._isTimepointBuffered(target)) {
                    if (this._progressChecker != null) {
                        window.clearTimeout(this._progressChecker);
                        this._progressChecker = null;
                    }
                    // .currentTime is consists with .buffered timestamp
                    // Chrome/Edge use DTS, while FireFox/Safari use PTS
                    this._msectl.seek(target);
                    this._transmuxer.seek(Math.floor(target * 1000));
                    // set currentTime if accurateSeek, or wait for recommend_seekpoint callback
                    if (this._config.accurateSeek) {
                        this._requestSetTime = true;
                        this._mediaElement.currentTime = target;
                    }
                }
            } else {
                window.setTimeout(this._checkAndApplyUnbufferedSeekpoint.bind(this), 50);
            }
        }
    }

    _checkAndResumeStuckPlayback(stalled) {
        let media = this._mediaElement;
        if (stalled || !this._receivedCanPlay || media.readyState < 2) {  // HAVE_CURRENT_DATA
            let buffered = media.buffered;
            if (buffered.length > 0 && media.currentTime < buffered.start(0)) {
                Log.w(this.TAG, `Playback seems stuck at ${media.currentTime}, seek to ${buffered.start(0)}`);
                this._requestSetTime = true;
                this._mediaElement.currentTime = buffered.start(0);
                this._mediaElement.removeEventListener('progress', this.e.onvProgress);
            }
        } else {
            // Playback didn't stuck, remove progress event listener
            this._mediaElement.removeEventListener('progress', this.e.onvProgress);
        }
    }

    /**
     * 事件监听器
     * @param {事件} e 
     */
    _onvLoadedMetadata(e) {
        if (this._pendingSeekTime != null) {
            this._mediaElement.currentTime = this._pendingSeekTime;
            this._pendingSeekTime = null;
        }
    }

    /**
     * 事件监听器
     * @param {事件} e 
     */
    _onvSeeking(e) {  // handle seeking request from browser's progress bar
        let target = this._mediaElement.currentTime;
        let buffered = this._mediaElement.buffered;

        if (this._requestSetTime) {
            this._requestSetTime = false;
            return;
        }

        if (target < 1.0 && buffered.length > 0) {
            // seek to video begin, set currentTime directly if beginPTS buffered
            let videoBeginTime = buffered.start(0);
            if ((videoBeginTime < 1.0 && target < videoBeginTime) || Browser.safari) {
                this._requestSetTime = true;
                // also workaround for Safari: Seek to 0 may cause video stuck, use 0.1 to avoid
                this._mediaElement.currentTime = Browser.safari ? 0.1 : videoBeginTime;
                return;
            }
        }

        if (this._isTimepointBuffered(target)) {
            if (this._alwaysSeekKeyframe) {
                let idr = this._msectl.getNearestKeyframe(Math.floor(target * 1000));
                if (idr != null) {
                    this._requestSetTime = true;
                    this._mediaElement.currentTime = idr.dts / 1000;
                }
            }
            if (this._progressChecker != null) {
                this._checkProgressAndResume();
            }
            return;
        }

        this._seekpointRecord = {
            seekPoint: target,
            recordTime: this._now()
        };
        window.setTimeout(this._checkAndApplyUnbufferedSeekpoint.bind(this), 50);
    }

    /**
     * 事件监听器
     * @param {事件} e 
     */
    _onvCanPlay(e) {
        this._receivedCanPlay = true;
        this._mediaElement.removeEventListener('canplay', this.e.onvCanPlay);
    }

    /**
     * 事件监听器
     * @param {事件} e 
     */
    _onvStalled(e) {
        this._checkAndResumeStuckPlayback(true);
    }

    /**
     * 事件监听器
     * @param {事件} e 
     */
    _onvProgress(e) {
        this._checkAndResumeStuckPlayback();
    }

}

/**
 * 导出播放器类
 */
export default FlvPlayer;