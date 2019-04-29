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

// Represents an media sample (audio / video)
/**
 * 导出音视频采样信息类 - SampleInfo
 */
export class SampleInfo {

    /**
     * 构造函数
     * @param {dts} dts 
     * @param {pts} pts 
     * @param {duration} duration 
     * @param {originalDts} originalDts 
     * @param {isSync} isSync 
     */
    constructor(dts, pts, duration, originalDts, isSync) {
        this.dts = dts;
        this.pts = pts;
        this.duration = duration;
        this.originalDts = originalDts;
        this.isSyncPoint = isSync;
        this.fileposition = null;
    }

}

// Media Segment concept is defined in Media Source Extensions spec.
// Media Source Extensions规范中定义的  Media Segment （媒体段）。
// Particularly in ISO BMFF format, an Media Segment contains a moof box followed by a mdat box.
// 特别是在iso bmff格式中，媒体段包含一个moof box，后跟一个mdat box。
/**
 * 导出媒体段信息类 - MediaSegmentInfo
 */
export class MediaSegmentInfo {

    /**
     * 构造函数
     */
    constructor() {
        this.beginDts = 0;
        this.endDts = 0;
        this.beginPts = 0;
        this.endPts = 0;
        this.originalBeginDts = 0;
        this.originalEndDts = 0;
        this.syncPoints = [];     // SampleInfo[n], for video IDR frames only
        this.firstSample = null;  // SampleInfo
        this.lastSample = null;   // SampleInfo
    }

    /**
     * 添加同步点
     * @param {采样信息 - SampleInfo} sampleInfo 
     */
    appendSyncPoint(sampleInfo) {  // also called Random Access Point
        sampleInfo.isSyncPoint = true;
        this.syncPoints.push(sampleInfo);
    }

}

// Ordered list for recording video IDR frames, sorted by originalDts
// 按照originalDts排序，记录视频IDR帧的列表
/**
 * 导出 IDR帧列表类 - IDRSampleList
 */
export class IDRSampleList {

    /**
     * 构造函数
     */
    constructor() {
        this._list = [];
    }

    /**
     * 清空列表
     */
    clear() {
        this._list = [];
    }

    /**
     * 添加数组
     * @param {同步点} syncPoints 
     */
    appendArray(syncPoints) {
        let list = this._list;

        if (syncPoints.length === 0) {
            return;
        }

        if (list.length > 0 && syncPoints[0].originalDts < list[list.length - 1].originalDts) {
            this.clear();
        }

        Array.prototype.push.apply(list, syncPoints);
    }

    /**
     * 获取指定dts的前一个点
     * @param {dts} dts 
     */
    getLastSyncPointBeforeDts(dts) {
        if (this._list.length == 0) {
            return null;
        }

        let list = this._list;
        let idx = 0;
        let last = list.length - 1;
        let mid = 0;
        let lbound = 0;
        let ubound = last;

        if (dts < list[0].dts) {
            idx = 0;
            lbound = ubound + 1;
        }

        while (lbound <= ubound) {
            mid = lbound + Math.floor((ubound - lbound) / 2);
            if (mid === last || (dts >= list[mid].dts && dts < list[mid + 1].dts)) {
                idx = mid;
                break;
            } else if (list[mid].dts < dts) {
                lbound = mid + 1;
            } else {
                ubound = mid - 1;
            }
        }
        return this._list[idx];
    }

}

// Data structure for recording information of media segments in single track.
// 用于记录单轨媒体段信息的数据结构
/**
 * 导出媒体段信息列表类 - MediaSegmentInfoList
 */
export class MediaSegmentInfoList {

    /**
     * 构造函数
     * @param {类型} type 
     */
    constructor(type) {
        this._type = type;
        this._list = [];
        this._lastAppendLocation = -1;  // cached last insert location
    }

    /**
     * 获取type
     */
    get type() {
        return this._type;
    }

    /**
     * 获取length
     */
    get length() {
        return this._list.length;
    }

    /**
     * 检查是否为空
     */
    isEmpty() {
        return this._list.length === 0;
    }

    /**
     * 清空列表
     */
    clear() {
        this._list = [];
        this._lastAppendLocation = -1;
    }

    /**
     * 搜索在originalBeginDts之前的最近段
     * @param {originalBeginDts} originalBeginDts 
     */
    _searchNearestSegmentBefore(originalBeginDts) {
        let list = this._list;
        if (list.length === 0) {
            return -2;
        }
        let last = list.length - 1;
        let mid = 0;
        let lbound = 0;
        let ubound = last;

        let idx = 0;

        if (originalBeginDts < list[0].originalBeginDts) {
            idx = -1;
            return idx;
        }

        while (lbound <= ubound) {
            mid = lbound + Math.floor((ubound - lbound) / 2);
            if (mid === last || (originalBeginDts > list[mid].lastSample.originalDts &&
                                (originalBeginDts < list[mid + 1].originalBeginDts))) {
                idx = mid;
                break;
            } else if (list[mid].originalBeginDts < originalBeginDts) {
                lbound = mid + 1;
            } else {
                ubound = mid - 1;
            }
        }
        return idx;
    }

    /**
     * 搜索在originalBeginDts之后的最近段
     * @param {originalBeginDts} originalBeginDts 
     */
    _searchNearestSegmentAfter(originalBeginDts) {
        return this._searchNearestSegmentBefore(originalBeginDts) + 1;
    }

    /**
     * 添加媒体段信息
     * @param {媒体段信息} mediaSegmentInfo 
     */
    append(mediaSegmentInfo) {
        let list = this._list;
        let msi = mediaSegmentInfo;
        let lastAppendIdx = this._lastAppendLocation;
        let insertIdx = 0;

        if (lastAppendIdx !== -1 && lastAppendIdx < list.length &&
                                    msi.originalBeginDts >= list[lastAppendIdx].lastSample.originalDts &&
                                    ((lastAppendIdx === list.length - 1) ||
                                    (lastAppendIdx < list.length - 1 &&
                                    msi.originalBeginDts < list[lastAppendIdx + 1].originalBeginDts))) {
            insertIdx = lastAppendIdx + 1;  // use cached location idx
        } else {
            if (list.length > 0) {
                insertIdx = this._searchNearestSegmentBefore(msi.originalBeginDts) + 1;
            }
        }

        this._lastAppendLocation = insertIdx;
        this._list.splice(insertIdx, 0, msi);
    }

    /**
     * 获取在originalBeginDts之前的最后一个段
     * @param {originalBeginDts} originalBeginDts 
     */
    getLastSegmentBefore(originalBeginDts) {
        let idx = this._searchNearestSegmentBefore(originalBeginDts);
        if (idx >= 0) {
            return this._list[idx];
        } else {  // -1
            return null;
        }
    }

    /**
     * 获取在originalBeginDts之前的最后一个Sample
     * @param {originalBeginDts} originalBeginDts 
     */
    getLastSampleBefore(originalBeginDts) {
        let segment = this.getLastSegmentBefore(originalBeginDts);
        if (segment != null) {
            return segment.lastSample;
        } else {
            return null;
        }
    }

    /**
     * 获取在originalBeginDts之前的同步点
     * @param {originalBeginDts} originalBeginDts 
     */
    getLastSyncPointBefore(originalBeginDts) {
        let segmentIdx = this._searchNearestSegmentBefore(originalBeginDts);
        let syncPoints = this._list[segmentIdx].syncPoints;
        while (syncPoints.length === 0 && segmentIdx > 0) {
            segmentIdx--;
            syncPoints = this._list[segmentIdx].syncPoints;
        }
        if (syncPoints.length > 0) {
            return syncPoints[syncPoints.length - 1];
        } else {
            return null;
        }
    }

}