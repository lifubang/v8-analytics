'use strict';
const co = require('co');
const stream = require('stream');
const JSONStream = require('JSONStream');
const HeapSnapshotWorker = require('../src/HeapSnapshotWorker');

//From v8/include/v8-profiler.h
const HeapGraphEdgeType = {
    kContextVariable: 0,  // A variable from a function context.
    kElement: 1,          // An element of an array.
    kProperty: 2,         // A named object property.
    kInternal: 3,         // A link that can't be accessed from JS, thus, its name isn't a real property name (e.g. parts of a ConsString).
    kHidden: 4,           // A link that is needed for proper sizes calculation, but may be hidden from user.
    kShortcut: 5,         // A link that must not be followed during sizes calculation.
    kWeak: 6              // A weak reference (ignored by the GC).
};

/**
 * serialize unique heap node
 */
function heapNodeSerialize(jsHeapSnapShot, index, limit, rootIndex) {
    //obtain all heap node & edge's meta info
    let meta = jsHeapSnapShot._metaNode;
    //obtain nodes & edges * sytings
    let nodes = jsHeapSnapShot.nodes;
    let edges = jsHeapSnapShot.containmentEdges;
    let strings = jsHeapSnapShot.strings;
    //obtain node_filed's length & edge_field's length
    let nodeFieldCount = jsHeapSnapShot._nodeFieldCount;
    let edgeFieldsCount = jsHeapSnapShot._edgeFieldsCount;
    //obtain node-edges map relationship
    let firstEdgeIndexes = jsHeapSnapShot._firstEdgeIndexes;
    //obtain every heap node's retainedSize & distance
    let retainedSizeList = jsHeapSnapShot._retainedSizes;
    let distancesList = jsHeapSnapShot._nodeDistances;

    let nodeDetail = nodes.slice(index * nodeFieldCount, index * nodeFieldCount + nodeFieldCount);
    let edge_count = Number(nodeDetail[4]);
    let serialNode = {
        index: index,
        type: meta.node_types[0][nodeDetail[0]],
        name: strings[nodeDetail[1]],
        id: `@${nodeDetail[2]}`,
        trace_node_id: Number(nodeDetail[5]),
        children: [],
        retainedSize: Number(retainedSizeList[index]),
        distance: Number(distancesList[index])
    };

    let offset = firstEdgeIndexes[index];

    //更改处理逻辑，将所有数据缓存至 all 数组
    let all = [];
    //获取最大的节点信息
    let biggest = { index: 0, size: 0, _index: 0 };

    for (let i = 0; i < edge_count; i++) {
        let edgeDetail = edges.slice(offset, offset + edgeFieldsCount);

        let name_or_index = Boolean(Number(edgeDetail[0]) === Number(HeapGraphEdgeType.kElement) ||
            Number(edgeDetail[0]) === Number(HeapGraphEdgeType.kHidden)) ? `[${String(edgeDetail[1])}]` : `${strings[edgeDetail[1]]}`;

        let edge_index = edgeDetail[2] / nodeFieldCount;
        let retainedSize = Number(retainedSizeList[edge_index]);

        //简单判断出最大的节点
        if (biggest.size < retainedSize) {
            biggest.index = edge_index;
            biggest.size = retainedSize;
            biggest._index = i;
        }

        //缓存所有节点
        all.push({
            index: edge_index,
            name_or_index: name_or_index,
            to_node: `@${nodes[edgeDetail[2] + 2]}`,
            type: meta.edge_types[0][edgeDetail[0]]
        })

        offset += edgeFieldsCount;
    }

    //取出最大的节点，如果存在，则放入首位
    const big = all[biggest._index];
    big && serialNode.children.push(big);

    //有限制的情况下存储限制的节点数
    for (let i = 0, l = all.length; i < l; i++) {
        //最大的节点已经处理过
        if (i === biggest._index) continue;
        //只取出下一个节点
        // if (index !== rootIndex && (distancesList[all[i].index] - 1) !== distancesList[index]) continue;

        //有限制的情况仅仅存储 limit 个数的节点
        if (limit && index !== rootIndex) {
            //已经存储到了限制则跳出循环
            if (serialNode.children.length === limit) break;
        }

        //存储节点
        serialNode.children.push(all[i]);
    }

    return serialNode;
}

/**
 * obtain jsHeapSnapShot & heapMap
 */
function heapSnapShotCalculateP(heapData, options) {
    return co(_heapSnapShot, heapData, options)

    /**
     * Inner Function
     */
    function* _heapSnapShot(heapData, options) {
        const jsHeapSnapShot = new HeapSnapshotWorker.JSHeapSnapshot(heapData, {
            updateStatusP(msg, end) {
                const cb = options.callback;
                const params = options.params.apply(options, [msg, Date.now(), end]);
                return cb(params.message, params.socket);
            },

            consoleWarn(str) {
                // console.warn(str);
            }
        });
        //load data
        yield jsHeapSnapShot.initializeP();

        const needed = [`_statistics`, `_aggregates`, `_metaNode`, `nodes`, `containmentEdges`, `strings`, `_nodeFieldCount`, `_edgeFieldsCount`, `_firstEdgeIndexes`, `_retainedSizes`, `_nodeDistances`];
        //taken out
        Object.keys(jsHeapSnapShot).forEach(key => { if (!~needed.indexOf(key)) jsHeapSnapShot[key] = null; });
        //release heapData
        heapData = null;

        return jsHeapSnapShot;
    }
}

/**
 * peakLeakPoint: suspicious mem leak point
 */
function peakLeakPoint(jsHeapSnapShot, rootIndex, limit) {
    limit = limit || 5;

    let distancesList = jsHeapSnapShot._nodeDistances;
    let retainedSizeList = jsHeapSnapShot._retainedSizes;

    let leakPoint = retainedSizeList.reduce((pre, next, index) => {
        if (index === rootIndex) return pre;

        if (Number(distancesList[index]) <= 1 || Number(distancesList[index]) >= 100000000) return pre;

        if (pre.length < limit) {
            pre.leakPoint.push({ index, size: next });
            pre.length++;
        } else {
            pre.leakPoint.sort((o, n) => Number(o.size) < Number(n.size) ? 1 : -1);
            if (pre.leakPoint[pre.leakPoint.length - 1].size < next) {
                pre.leakPoint.pop();
                pre.leakPoint.push({ index, size: next });
            }
        }

        return pre;
    }, { leakPoint: [], length: 0, }).leakPoint;

    return leakPoint
}


/*
 * get heapsnapshot usage
*/
function heapUsageP(heapData, options) {
    return co(_heap, heapData, options);

    /**
     * Inner Function
     */
    function* _heap(heapData, options) {
        options = options || {};

        //let {heapMap, rootIndex} = handleHeapData(heapData);
        const rootIndex = heapData.snapshot.root_index || 0;
        let jsHeapSnapShot = yield heapSnapShotCalculateP(heapData, options);
        let leakPoint = peakLeakPoint(jsHeapSnapShot, rootIndex, options.limit);

        return { leakPoint, jsHeapSnapShot, rootIndex };
    }
}

/**
 * @param {stream} transform @param {object} options 
 * @return {promise}
 * @description more efficient heap memory analysis
 */
function fetchHeapUsageP(transform, options) {
    const isStream = Boolean(transform instanceof stream.Stream);

    return new Promise((resolve, reject) => {
        if (isStream) {
            const parser = JSONStream.parse();
            transform.pipe(parser);

            parser.on('data', heapData => {
                const cb = options.callback;
                const params = options.params.apply(options, [{ prefix: `Memory 流式数据准备完毕`, suffix: `准备开始构建 Edge Indexs` }, Date.now()]);
                cb(params.message, params.socket).then(() => heapUsageP(heapData, options)).then(resolve).catch(reject);
            });

            parser.on('error', reject);
        } else {
            heapUsageP(transform, options).then(resolve).catch(reject);
        }
    });
}

module.exports = { fetchHeapUsageP, heapNodeSerialize };