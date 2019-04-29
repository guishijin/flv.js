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

import Log from '../utils/logger.js';
import LoggingControl from '../utils/logging-control.js';
import Polyfill from '../utils/polyfill.js';
import TransmuxingController from './transmuxing-controller.js';
import TransmuxingEvents from './transmuxing-events.js';

/* post message to worker:
   data: {
       cmd: string
       param: any
   }

   receive message from worker:
   data: {
       msg: string,
       data: any
   }
 */
/**
 * 定义TransmuxingWorker为一个匿名函数
 * @param {self} self 
 */
let TransmuxingWorker = function (self) {

    let TAG = 'TransmuxingWorker';
    let controller = null;
    let logcatListener = onLogcatCallback.bind(this);

    // 安装垫片
    Polyfill.install();

    // 添加监听器
    self.addEventListener('message', function (e) {
        switch (e.data.cmd) {
            case 'init':
                controller = new TransmuxingController(e.data.param[0], e.data.param[1]);
                controller.on(TransmuxingEvents.IO_ERROR, onIOError.bind(this));
                controller.on(TransmuxingEvents.DEMUX_ERROR, onDemuxError.bind(this));
                controller.on(TransmuxingEvents.INIT_SEGMENT, onInitSegment.bind(this));
                controller.on(TransmuxingEvents.MEDIA_SEGMENT, onMediaSegment.bind(this));
                controller.on(TransmuxingEvents.LOADING_COMPLETE, onLoadingComplete.bind(this));
                controller.on(TransmuxingEvents.RECOVERED_EARLY_EOF, onRecoveredEarlyEof.bind(this));
                controller.on(TransmuxingEvents.MEDIA_INFO, onMediaInfo.bind(this));
                controller.on(TransmuxingEvents.METADATA_ARRIVED, onMetaDataArrived.bind(this));
                controller.on(TransmuxingEvents.SCRIPTDATA_ARRIVED, onScriptDataArrived.bind(this));
                controller.on(TransmuxingEvents.STATISTICS_INFO, onStatisticsInfo.bind(this));
                controller.on(TransmuxingEvents.RECOMMEND_SEEKPOINT, onRecommendSeekpoint.bind(this));
                break;
            case 'destroy':
                if (controller) {
                    controller.destroy();
                    controller = null;
                }
                self.postMessage({msg: 'destroyed'});
                break;
            case 'start':
                controller.start();
                break;
            case 'stop':
                controller.stop();
                break;
            case 'seek':
                controller.seek(e.data.param);
                break;
            case 'pause':
                controller.pause();
                break;
            case 'resume':
                controller.resume();
                break;
            case 'logging_config': {
                let config = e.data.param;
                LoggingControl.applyConfig(config);

                if (config.enableCallback === true) {
                    LoggingControl.addLogListener(logcatListener);
                } else {
                    LoggingControl.removeLogListener(logcatListener);
                }
                break;
            }
        }
    });

    /**
     * 初始段事件
     * @param {audio/video} type 
     * @param {初始的段} initSegment 
     */
    function onInitSegment(type, initSegment) {
        let obj = {
            msg: TransmuxingEvents.INIT_SEGMENT,
            data: {
                type: type,
                data: initSegment
            }
        };
        self.postMessage(obj, [initSegment.data]);  // data: ArrayBuffer
    }

    /**
     * 媒体段事件
     * @param {audio/video} type 
     * @param {媒体段} mediaSegment 
     */
    function onMediaSegment(type, mediaSegment) {
        let obj = {
            msg: TransmuxingEvents.MEDIA_SEGMENT,
            data: {
                type: type,
                data: mediaSegment
            }
        };
        self.postMessage(obj, [mediaSegment.data]);  // data: ArrayBuffer
    }

    /**
     * 加载完成
     */
    function onLoadingComplete() {
        let obj = {
            msg: TransmuxingEvents.LOADING_COMPLETE
        };
        self.postMessage(obj);
    }

    /**
     * 过早结束
     */
    function onRecoveredEarlyEof() {
        let obj = {
            msg: TransmuxingEvents.RECOVERED_EARLY_EOF
        };
        self.postMessage(obj);
    }

    /**
     * 媒体信息
     * @param {媒体信息} mediaInfo 
     */
    function onMediaInfo(mediaInfo) {
        let obj = {
            msg: TransmuxingEvents.MEDIA_INFO,
            data: mediaInfo
        };
        self.postMessage(obj);
    }

    /**
     * 媒体数据到达
     * @param {媒体数据} metadata 
     */
    function onMetaDataArrived(metadata) {
        let obj = {
            msg: TransmuxingEvents.METADATA_ARRIVED,
            data: metadata
        };
        self.postMessage(obj);
    }

    /**
     * 脚本数据到达
     * @param {脚本数据} data 
     */
    function onScriptDataArrived(data) {
        let obj = {
            msg: TransmuxingEvents.SCRIPTDATA_ARRIVED,
            data: data
        };
        self.postMessage(obj);
    }

    /**
     * 统计信息
     * @param {统计信息} statInfo 
     */
    function onStatisticsInfo(statInfo) {
        let obj = {
            msg: TransmuxingEvents.STATISTICS_INFO,
            data: statInfo
        };
        self.postMessage(obj);
    }

    /**
     * IO错误信息
     * @param {类型} type 
     * @param {信息} info 
     */
    function onIOError(type, info) {
        self.postMessage({
            msg: TransmuxingEvents.IO_ERROR,
            data: {
                type: type,
                info: info
            }
        });
    }

    /**
     * 解封装器错误信息
     * @param {类型} type 
     * @param {信息} info 
     */
    function onDemuxError(type, info) {
        self.postMessage({
            msg: TransmuxingEvents.DEMUX_ERROR,
            data: {
                type: type,
                info: info
            }
        });
    }

    /**
     * 
     * @param {毫秒} milliseconds 
     */
    function onRecommendSeekpoint(milliseconds) {
        self.postMessage({
            msg: TransmuxingEvents.RECOMMEND_SEEKPOINT,
            data: milliseconds
        });
    }

    /**
     * 日志信息
     * @param {类型} type 
     * @param {日志信息} str 
     */
    function onLogcatCallback(type, str) {
        self.postMessage({
            msg: 'logcat_callback',
            data: {
                type: type,
                logcat: str
            }
        });
    }

};

/**
 * 导出转封装工作线程类 - TransmuxingWorker
 */
export default TransmuxingWorker;